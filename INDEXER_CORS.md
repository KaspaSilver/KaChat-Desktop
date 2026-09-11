# Indexer needs CORS headers

**For:** whoever maintains the KaChat indexer at `kachat.duckdns.org` (nginx 1.27.5).
**Symptom:** the KaChat web app at `https://kachat.app/desktop/` cannot load anything — chats,
messages, groups and balances all fail at once, and the browser console fills with
`blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present` followed by
`net::ERR_FAILED 200 (OK)`.

The `200 (OK)` next to `ERR_FAILED` is the tell: the server answered correctly, and the **browser**
threw the response away because the header that authorises a cross-origin read was missing.

## What is actually wrong

The indexer serves a different origin from the app that calls it:

| | |
|---|---|
| Page origin | `https://kachat.app` |
| API origin | `https://kachat.duckdns.org` |

Different host, so every request is cross-origin. A browser will only hand a cross-origin response
to JavaScript if the server says it may, via `Access-Control-Allow-Origin`. The indexer currently
sends no such header on any response.

Reproduce it in one command — note the absence of any `access-control-*` line:

```bash
curl -sS -o /dev/null -D - -H "Origin: https://kachat.app" \
  "https://kachat.duckdns.org/handshakes/by-receiver?address=test"
```

```
HTTP/2 400
server: nginx/1.27.5
content-type: application/json
strict-transport-security: max-age=31536000
```

This is **not** a firewall, TLS, rate-limit or routing problem. The request arrives, is processed,
and is answered. Only the browser-facing permission is missing.

## Who is affected

- **Affected:** the desktop/web app, and anyone self-hosting it on their own domain.
- **Not affected:** the iOS and Android apps. They are not browsers, so CORS never applies to them.
  If someone reports "it works on my phone but not in the browser", this is why.

## The fix

Add these to the `server` block that serves the indexer (or to each relevant `location`), then
reload nginx.

```nginx
# Authorise browser apps to read our responses.
# $http_origin reflects whichever origin asked; see "Restricting it" below to allowlist instead.
add_header Access-Control-Allow-Origin  $http_origin always;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
add_header Access-Control-Allow-Headers "Content-Type, Accept" always;
add_header Access-Control-Max-Age       86400 always;
# Responses vary by Origin, so caches must not serve one origin's response to another.
add_header Vary "Origin" always;

# Preflight: the browser sends OPTIONS before any POST or any request with a custom
# Content-Type, and will not send the real request until it gets a successful answer.
if ($request_method = OPTIONS) {
    return 204;
}
```

### Three details that are easy to get wrong

1. **`always` is not optional.** Without it, nginx adds the header only to 2xx/3xx responses. Every
   400, 429 and 502 would then come back headerless, so rate-limit and error responses reappear as
   CORS failures — which reads like the fix did not work. Note the reproduction above returns 400.

2. **The `OPTIONS` branch must return before any auth/proxy logic.** A preflight carries no
   credentials and no body. If it is routed into the application it will usually 404 or 405, and
   the browser will abandon the real request without ever sending it.

3. **`add_header` does not inherit into a `location` that has its own `add_header`.** If any
   `location` block in this server already calls `add_header` for anything, nginx discards the
   server-level ones *for that location only*, and you must repeat the CORS lines inside it. This
   is the single most common reason a correct-looking config fixes some endpoints and not others.

### Restricting it (optional)

Reflecting `$http_origin` allows any website to call the indexer from a browser. That is the same
access anyone already has with `curl`, and these endpoints are public reads with no cookies or
credentials involved, so it grants nothing new. If you would rather allowlist:

```nginx
map $http_origin $cors_origin {
    default                        "";
    "https://kachat.app"           $http_origin;
    "http://localhost:5173"        $http_origin;   # local development
}

# then, in the server block:
add_header Access-Control-Allow-Origin $cors_origin always;
```

Do **not** use `Access-Control-Allow-Origin: *` together with
`Access-Control-Allow-Credentials: true` — browsers reject that combination outright. The app sends
no credentials, so simply do not add the credentials header at all.

## Verifying the fix

A normal request now carries the header:

```bash
curl -sS -o /dev/null -D - -H "Origin: https://kachat.app" \
  "https://kachat.duckdns.org/handshakes/by-receiver?address=test" | grep -i access-control
```

Expected: `access-control-allow-origin: https://kachat.app`

A preflight is answered without reaching the app:

```bash
curl -sS -o /dev/null -D - -X OPTIONS \
  -H "Origin: https://kachat.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" \
  "https://kachat.duckdns.org/group-control/by-recipient" | head -8
```

Expected: `HTTP/2 204` plus the `access-control-*` headers.

And an **error** response carries it too — this is the check that catches a missing `always`:

```bash
curl -sS -o /dev/null -D - -H "Origin: https://kachat.app" \
  "https://kachat.duckdns.org/definitely-not-a-real-path" | grep -i access-control
```

Expected: the header is present on the 404 as well.

## Endpoints the web app calls

All of these need to work from a browser, so whatever you change must cover the whole server rather
than one path:

```
/handshakes/by-receiver
/handshakes/by-sender
/contextual-messages/by-sender
/group-control/by-recipient
/group-control/by-sender
/group-messages/by-blinded-group-id
/get-broadcasts
/upload/image
/metrics
/get-posts                /get-posts-watching      /get-contents-following
/get-replies              /get-post-engagement     /get-user-details
/get-notifications        /get-users-following     /get-users-followers
```

## Context: the app is not waiting on this

A same-origin proxy in the web app now forwards these calls through the server that hosts the page,
so `kachat.app` works without any change here. This fix is still worth making:

- it removes an unnecessary hop through the web host for every request,
- it is the only thing that helps anyone self-hosting the app on a static host, where there is no
  proxy to fall back on,
- and it makes the indexer usable from a browser by anything else, ever.
