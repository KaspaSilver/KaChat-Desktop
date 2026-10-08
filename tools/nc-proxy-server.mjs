#!/usr/bin/env node
// Standalone /nc-proxy server for STATIC (nginx-served) deployments: kachat.app/desktop and
// kachatdesktoptest.duckdns.org, where there is no Vite server to provide the relay.
//
// All relay behaviour lives in ./relay-guard.mjs, shared with vite.config.mjs, so the two can no
// longer drift apart. DEPLOY BOTH FILES side by side (e.g. /opt/kachat-ncproxy/nc-proxy-server.mjs
// and /opt/kachat-ncproxy/relay-guard.mjs); this file alone will not start. Node 20+, no packages.
//
// This server is PUBLIC-facing, so private/LAN addresses are never reachable from it (unlike a
// private dev server with KACHAT_RELAY_ALLOW_PRIVATE=1).
//
// Environment:
//   NC_PROXY_PORT / NC_PROXY_HOST     listen address (default 0.0.0.0:8790)
//   NC_PROXY_UPSTREAM_TIMEOUT_MS      read inactivity limit (default 30000; writes get >= 120 s)
//   KACHAT_TRUSTED_PROXIES            peers whose X-Forwarded-For is believed for rate limiting.
//                                     Default `loopback`. In a container the reverse proxy on the
//                                     host arrives from the bridge gateway (e.g. 172.17.0.1), so
//                                     set e.g. KACHAT_TRUSTED_PROXIES=172.17.0.1 there, and have
//                                     nginx send `X-Forwarded-For $remote_addr`. See relay-guard.mjs.
//   KACHAT_TRUST_CF_CONNECTING_IP=1   also believe cf-connecting-ip from a trusted proxy (only when
//                                     that proxy really sits behind Cloudflare)
//   KACHAT_RELAY_RATE_MAX             requests per client per minute (default 600; an IPv6 client
//                                     counts by its /64)
import http from "node:http";
import { createRelay } from "./relay-guard.mjs";

const PORT = Number(process.env.NC_PROXY_PORT || 8790);
const HOST = process.env.NC_PROXY_HOST || "0.0.0.0";

const relay = createRelay({
  allowPrivate: false,
  trustedProxies: process.env.KACHAT_TRUSTED_PROXIES,
  trustCfConnectingIp: String(process.env.KACHAT_TRUST_CF_CONNECTING_IP || "") === "1",
  readTimeoutMs: Number(process.env.NC_PROXY_UPSTREAM_TIMEOUT_MS || 30000),
  rateMax: Number(process.env.KACHAT_RELAY_RATE_MAX || 600),
  log: (line) => console.warn(line),
});

const server = http.createServer((req, res) => {
  // Cheap liveness endpoint for the container healthcheck (not proxied).
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  // nginx passes the raw (still URL-encoded) URI; strip the mount here. An optional /desktop
  // prefix lets the same server sit behind /nc-proxy/ or /desktop/nc-proxy/. Do NOT use an nginx
  // `rewrite` for this: it decodes %2F and corrupts the encoded origin.
  const rest = String(req.url || "").replace(/^(?:\/desktop)?\/nc-proxy(?=\/|\?|$)/, "");
  try {
    relay.handle(req, res, rest);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(`nc-proxy error: ${error?.message || error}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`nc-proxy listening on ${HOST}:${server.address().port}`);
});
