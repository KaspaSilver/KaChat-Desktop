# desktop.kachat.app on Cloudflare Pages

desktop.kachat.app is the built site (`dist/`) on Cloudflare Pages, plus the `/nc-proxy` relay as a
Pages Function (`functions/nc-proxy/[[path]].js`). Both deploy from every push to `main`.

## Pages project

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node | 22 (`.node-version`) |
| Custom domain | `desktop.kachat.app` |

Environment variables (Settings > Variables and Secrets, Production):

| Name | Type | What |
|---|---|---|
| `CHANGENOW_API_KEY` | Secret | The server's ChangeNOW key for Swap. Unset: Swap says "not available right now" |
| `KACHAT_RELAY_RATE_MAX` | Text, optional | Relay requests per client per minute (default 600) |
| `KACHAT_CHANGENOW_RATE_MAX` | Text, optional | Key-attached swap calls per client per minute (default 30) |

## What serves what

- **The page and its files**: static, with the headers in `public/_headers` (the https policy from
  `tools/security-headers.mjs`, see SECURITY_HEADERS.md) and a year's cache on `/assets/*`, whose
  names carry a content hash. An unknown path gets `index.html`, as on the old nginx.
- **`/nc-proxy/*`**: the Pages Function. Same rules as the Node relay (`tools/relay-rules.mjs`, shared
  by both), for a site other people open: no Nextcloud or Talk, the ChangeNOW key only on the four
  swap calls from this site's own pages, sandboxed answers. The comment at the top of the function
  says what differs from the Node relay and why.

## Limits and cost

Static requests are free and unlimited. Every relay call is a Function request, and a sync can make
several hundred a minute per person, so the free plan's 100,000 a day runs out with a few active
users. Workers Paid ($5 a month) covers 10 million a month.

The relay's own rate limit counts per Cloudflare isolate, so it is a backstop. The real limit is a
WAF rate-limiting rule (Security > WAF > Rate limiting rules): requests whose path starts with
`/nc-proxy/`, counted per IP, for example 600 a minute, action Block for a minute.

## Checking

```sh
node tools/test-pages-relay.mjs          # the Function, with fetch replaced (no network)
node tools/test-security-headers.mjs     # public/_headers matches the policy
curl -sI https://desktop.kachat.app/ | grep -iE 'content-security|x-frame'
curl -s https://desktop.kachat.app/nc-proxy/__probe          # kachat-proxy
curl -s https://desktop.kachat.app/nc-proxy/__swap           # on (with CHANGENOW_API_KEY) or off
```
