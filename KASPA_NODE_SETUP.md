# Running our own Kaspa node for KaChat

**For:** whoever runs the KaChat server infrastructure.
**Goal:** a Kaspa node we control, reachable at a stable `wss://` address, that every KaChat client
uses by default instead of the public resolver pool.

## Why

The web client is served over HTTPS, and a browser will not open a plaintext `ws://` socket from an
HTTPS page. The public resolver hands out a mix of endpoints and we do not control what it returns,
how healthy they are, or whether they survive. Kasia solved this the same way: their web app has a
single hardcoded default, `wss://wrpc.kasia.fyi`, their own node, and never calls the resolver at
all. This is that.

Once it is up, hand back the final `wss://` URL and it gets set as the built-in default in the web,
iOS and Android clients. Users keep the ability to point at their own node instead.

---

## 1. What the node must be

Standard **rusty-kaspa** (`kaspad`), mainnet, fully synced. Nothing custom, no fork.

Two things are not optional:

- **`--utxoindex`.** Without it the node cannot answer `getUtxosByAddresses` or serve
  `utxosChanged` subscriptions, and every KaChat client depends on both. A node that is otherwise
  perfectly healthy is useless to us without this flag. If the node has already synced without it,
  enabling it requires a reindex — plan for that rather than discovering it later.
- **wRPC with Borsh encoding.** That is what the clients speak. JSON-RPC on 18110 is not used and
  does not need exposing.

Verify the flag names against `kaspad --help` for the version you install rather than trusting the
list below verbatim — they have moved between releases.

```
kaspad \
  --utxoindex \
  --rpclisten-borsh=127.0.0.1:17110 \
  --rpclisten=127.0.0.1:16110 \
  --disable-upnp \
  --yes
```

Ports, for reference (mainnet):

| Port | Protocol | Who needs it |
|---|---|---|
| 16111 | P2P | the network — must be reachable inbound or the node will not peer well |
| 16110 | gRPC | the iOS and Android clients |
| 17110 | wRPC **Borsh** | the web client, via the TLS proxy below |
| 18110 | wRPC JSON | nobody — leave it off |

Bind the RPC listeners to `127.0.0.1`, not `0.0.0.0`. They are reached through the reverse proxy,
which is where TLS and rate limiting live. Only 16111 should be open to the world directly.

## 2. TLS in front of wRPC

The browser needs `wss://`. Terminate TLS at nginx and proxy to the plaintext wRPC port.

```nginx
server {
    listen 443 ssl http2;
    server_name node.kachat.app;          # whatever name you settle on

    ssl_certificate     /etc/letsencrypt/live/node.kachat.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/node.kachat.app/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:17110;

        # WebSocket upgrade. Without these three the handshake fails and the client sees a
        # connection that opens and immediately closes.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;

        # KaChat holds a block-added subscription open and can sit quiet between blocks. The
        # default 60s read timeout would drop those sockets repeatedly; the client reconnects, so
        # the symptom is not an outage but a node that looks flaky.
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;

        # Streaming, not buffering - notifications must not be held back.
        proxy_buffering off;
    }
}
```

No CORS headers are needed here: WebSocket connections are not subject to CORS the way `fetch` is.

## 3. What the clients actually call

Keep this list — it is the whole surface, so anything that breaks will break one of these.

**Web client, over wRPC/Borsh:**

| Call | Used for |
|---|---|
| `getServerInfo` | connection health, and the sync + network check on connect |
| `getUtxosByAddresses` | balances and spendable inputs (**needs `--utxoindex`**) |
| `submitTransaction` | sending messages and payments |
| `subscribeBlockAdded` / `unsubscribeBlockAdded` | live delivery — a long-lived subscription |

**iOS and Android, over gRPC (16110):** the same reads and submits, plus `notifyUtxosChanged`
subscriptions per watched address and `getPeerAddresses` for their own node discovery.

Two properties the clients check and will refuse a node over:

- `getServerInfo().isSynced` must be true. A node still syncing is rejected rather than used.
- `getServerInfo().networkId` must be `mainnet`.

## 4. Capacity and exposure

This node becomes the default for every user, so it is no longer a personal node.

- **Connections.** Every open app holds at least one WebSocket, plus a subscription. Budget for
  concurrent sockets rather than requests per second — the load is long-lived connections, not
  bursts. Raise `worker_connections` in nginx and the system file-descriptor limit accordingly;
  the defaults will be the first thing to run out.
- **Rate limiting.** `submitTransaction` is the one that costs something. Consider a
  `limit_req` zone keyed on `$binary_remote_addr` for the proxy, sized generously enough that a
  normal user never trips it.
- **Disk.** A pruned mainnet node is the normal configuration and still grows over time. Check
  current rusty-kaspa guidance for today's figure rather than sizing from an old number, and leave
  meaningful headroom — a node that runs out of disk stops serving everybody at once.
- **Monitoring.** At minimum: process alive, `isSynced` still true, and the TLS certificate's
  expiry. A node that silently falls out of sync is worse than one that is down, because clients
  will connect to it and then fail confusingly.
- **A second node.** Not required to start, but the moment this is the default for everyone it is a
  single point of failure. The clients fall back to the public resolver if our node is unreachable,
  so an outage degrades rather than breaks — worth confirming that fallback still behaves once the
  default changes.

## 5. When it is ready

Hand back:

1. the **`wss://` URL** (host only, no port, if nginx is on 443 — e.g. `wss://node.kachat.app`),
2. confirmation that `getServerInfo` reports `isSynced: true` on mainnet,
3. whether gRPC on 16110 is also exposed, and at what address, for the phone clients.

A quick check from any machine, which should print server info rather than hanging:

```bash
websocat wss://node.kachat.app
```

If that connects, the clients will.
