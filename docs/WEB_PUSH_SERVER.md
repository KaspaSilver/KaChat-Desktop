# Web Push in the KaChat push service

**For:** whoever owns `kachat-indexer` (the push service: `kasia-indexer/indexer/src/api/v1/push.rs`
and `kasia-indexer/indexer/src/push.rs`).
**From:** KaChat Desktop (the web app / installed PWA). The client side is finished and shipped
inert: `ui/web-push.js`, `ui/web-push-core.js`, `public/sw.js`, `public/sw-push.js`.
**Goal:** the installed web app (iPhone home-screen app on iOS 16.4+, Android Chrome, desktop
browsers) gets notifications while it is closed, the way the iPhone app does through APNs.

Until the service has the pieces below, the app shows "Notifications when KaChat is closed: not
available on this server yet" and keeps notifying only while it is open. Nothing else changes for
iOS, macOS or Android devices.

Everything here mirrors what already exists for `android` (FCM): a new platform string, one more
transport in `deliver()`, and the FCM data map reused as the payload.

---

## 1. Summary of changes

| # | Where | What |
|---|---|---|
| 1 | `push.rs` `SUPPORTED_PLATFORMS` | add `"web"` |
| 2 | `push.rs` `normalize_device_token` | accept an `https://` endpoint URL as a token, verbatim |
| 3 | `api/v1/push.rs` request structs + `DeviceRegistration` | optional `web_push: {endpoint, p256dh, auth}`, stored on the value, outside the auth preimage |
| 4 | config / env | VAPID key pair + subject |
| 5 | `api/v1/push.rs` router | `GET /v1/push/web-config` → `{"vapid_public_key": "<base64url>"}` |
| 6 | `push.rs` `deliver()` | a WebPush transport for `platform == "web"` (RFC 8291 + RFC 8292) |
| 7 | `push.rs` | TTL / urgency per event type; 404 / 410 → drop the registration |

No database migration: `DeviceRegistration` is serde JSON with `#[serde(default)]` fields, so the
new field is simply absent on existing rows.

---

## 2. Device tokens for `web`

The app sends `device_token` = the PushSubscription's `endpoint`, e.g.

```
https://web.push.apple.com/QGuQyavXutnMH6bR9...            (Safari / iOS)
https://fcm.googleapis.com/fcm/send/eYk3...:APA91bH...     (Chrome / Android Chrome / Edge)
https://updates.push.services.mozilla.com/wpush/v2/gAAAA... (Firefox)
```

Today `normalize_device_token` would reject these (`/` is not in the FCM charset). Add a first
branch, before the hex check:

```rust
// Web Push (platform "web"): the subscription endpoint URL, kept exactly as sent (trimmed).
if trimmed.starts_with("https://") {
    if trimmed.len() > MAX_WEB_ENDPOINT_LEN /* 2048 */ || trimmed.chars().any(|c| c.is_whitespace() || c.is_control()) {
        anyhow::bail!("Invalid web push endpoint");
    }
    return Ok(trimmed.to_string());
}
```

Rules the client already follows, which the server must match:

* The **auth preimage** hashes this normalized token: `device_token_hash = sha256_hex(endpoint)`
  (trimmed, case preserved). Same function on both paths, as today.
* `device_token` and `web_push.endpoint` are always equal. Reject a register/update where they
  differ (400 `web_push.endpoint must equal device_token`).
* Optionally restrict endpoint hosts to the known push services (`*.push.apple.com`,
  `fcm.googleapis.com`, `*.googleapis.com`, `updates.push.services.mozilla.com`,
  `*.notify.windows.com`) so the service can never be used to POST to arbitrary URLs (SSRF).
  Recommended.

`platform` stays in its 16-byte limit (`"web"`).

---

## 3. Register / update / unregister

### 3.1 Request fields

`PushRegistrationRequest` and `PushUpdateRequest` gain one optional field:

```rust
// Web Push subscription (platform "web"). Out of the auth preimage, like every optional field
// added after LegacyV1. Required when platform == "web"; ignored otherwise.
#[serde(default)]
pub web_push: Option<WebPushSubscription>,

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
pub struct WebPushSubscription {
    pub endpoint: String, // == device_token
    pub p256dh: String,   // base64url (no padding) of the subscriber's P-256 public key, 65 bytes uncompressed
    pub auth: String,     // base64url (no padding) of the 16-byte auth secret
}
```

Validation (400 on failure): `p256dh` decodes (use `decode_base64_any`) to 65 bytes starting `0x04`;
`auth` decodes to 16 bytes; `endpoint == device_token`. For `platform == "web"` without `web_push`
on **register**: 400 `web_push is required for platform web`. On **update** an absent `web_push`
keeps the stored one (same "don't clobber on a partial update" rule `apns_environment` uses).

Store it on `DeviceRegistration`:

```rust
#[serde(default)]
pub web_push: Option<WebPushSubscription>,
```

and thread it through `PushRegistryHandle::register/update` and the actor commands exactly like
`apns_environment` (value only, no index).

### 3.2 What the web client sends (exactly)

`POST /v1/push/register` (the client always uses register; it is an upsert, as on iOS):

```json
{
  "device_token": "https://web.push.apple.com/QGuQ...",
  "platform": "web",
  "watched_addresses": ["kaspa:qr...me", "kaspa:qp...alice"],
  "watched_group_ids": ["9f1c...64 hex", "..."],
  "watched_broadcast_channels": ["kaspa"],
  "hidden_broadcast_senders": { "kaspa": ["kaspa:qz...spam"] },
  "kaposts_pubkey": "02ab...66 hex",
  "kaposts_notify_likes": true,
  "kaposts_notify_dislikes": true,
  "kaposts_notify_comments": true,
  "kaposts_notify_reposts": true,
  "kaposts_notify_follows": true,
  "kaposts_watch_authors": ["89e6...64 hex (x-only)", "0359...66 hex"],
  "watch_only_addresses": ["kaspa:qq...spending1"],
  "primary_address": "kaspa:qr...me",
  "aliases": ["a1b2c3d4e5f6"],
  "web_push": { "endpoint": "https://web.push.apple.com/QGuQ...", "p256dh": "BOr...", "auth": "k3x..." },
  "auth": {
    "wallet_pubkey": "64 hex x-only",
    "wallet_address": "kaspa:qr...me",
    "nonce": "...", "timestamp_ms": 1792650000000, "expires_at_ms": 1792650060000,
    "signature": "128 hex BIP340",
    "device_auth": { "scheme": "device_key_v1", "key_id": "64 hex", "pubkey": "base64 65-byte P-256",
                     "counter": 1792650000123, "signature": "base64 64-byte r||s" }
  }
}
```

Notes for the server:

* **Auth is unchanged.** No `auth_version`; `watched_group_ids` is always an array, so
  `select_auth_format` picks `TransitionalGroups` (domain `kchat-push-auth:v1` with the
  `watched_group_ids_hash` line) - byte-for-byte what iOS signs. `web_push`, `platform`, the
  broadcast/KaPosts/watch-only fields stay **out of the preimage**.
* `primary_address` equals the wallet address (the group_v1 rule already enforces it).
* `device_auth` is the existing `device_key_v1` scheme. WebCrypto signs P1363 (`r||s`, 64 bytes);
  `verify_p256_signature` already tries ASN.1 then FIXED, so nothing to change. The counter is
  `max(last + 1, now_ms)` - large but monotonic, fits `u64`.
* Account switch on one browser: the endpoint is per browser, the wallet per account. The client
  first `DELETE /v1/push/unregister`s with device auth only (no wallet signature: `wallet_pubkey`,
  `wallet_address`, `signature` are empty strings, so `verify_wallet_binding_from_auth(...).ok()` is
  `None` and the device binding decides - existing code path), then registers for the new wallet.
  On `401 ... bound to another wallet` it does the same once, like iOS's recovery.
* Sign out / notifications off: `DELETE /v1/push/unregister` signed with the wallet (LegacyV1
  preimage over empty lists, the same as the server verifies today), plus device auth; the client
  then also unsubscribes the browser subscription, so a missed unregister ends in a 410 (§6.3).
* `watch_only_addresses`: the web client sends the spending / cold-storage addresses whose Address
  Activity is on (never the chatting address - its payments already come as `payment` pushes). The
  iPhone app sends none today; see "Owner decisions" in the client report.

### 3.3 Stats

`PushStats.by_platform` will show `web` by itself. Optionally add `web_push_endpoints_by_host`
(apple / fcm / mozilla / other) - useful when one provider misbehaves.

---

## 4. VAPID keys and `GET /v1/push/web-config`

### 4.1 Config

| env | meaning |
|---|---|
| `KACHAT_WEBPUSH_VAPID_PRIVATE_KEY` | the VAPID private key: base64url (no padding) of the raw 32-byte P-256 scalar, **or** a path to a PEM file (`-----BEGIN EC PRIVATE KEY-----` / PKCS#8) |
| `KACHAT_WEBPUSH_VAPID_SUBJECT` | `mailto:` or `https:` contact URL for the push services (RFC 8292 `sub`), e.g. `mailto:push@kachat.app` |
| `KACHAT_WEBPUSH_ENABLED` | optional; absent = enabled when the key is set |

Absent key = Web Push off: `web-config` answers 404, `deliver()` skips `web` tokens (they stay
registered; the client shows "not available").

The public key is **derived** from the private key at start-up (never configured separately, so
they cannot disagree). Never log the private key. Keep one key pair per network (mainnet and
testnet services each have their own); rotating it invalidates every web subscription (the client
notices the changed key via `web-config`, unsubscribes and registers again, so rotation is
self-healing within a day).

Generate a key pair (either):

```bash
# OpenSSL: PEM private key + base64url public key
openssl ecparam -name prime256v1 -genkey -noout -out vapid_private.pem
openssl ec -in vapid_private.pem -pubout -outform DER | tail -c 65 | base64 | tr '+/' '-_' | tr -d '=\n'; echo

# or Node, no files: prints both as base64url
npx --yes web-push generate-vapid-keys --json
```

Store the private key as a secret (Kaspa-Quick-Start's env / panel secret store), not in the repo.

### 4.2 The route

Public, mounted with the others under `/v1/push`:

```
GET /v1/push/web-config
200 {"vapid_public_key": "BNc...87 chars base64url (65-byte uncompressed P-256 point)"}
404 {"error": "web push is not configured"}      (no key set)
```

`Cache-Control: public, max-age=3600`. The client caches it 6 h and treats 404/405/501 as "this
server has no Web Push" (re-asked every 30 min).

CORS: the app reaches the service through its same-origin relay (`/nc-proxy`, see
`INDEXER_CORS.md`); nothing new is needed. If the nginx in front ever answers CORS itself, include
`GET, POST, PUT, DELETE` for `/v1/push/*`.

---

## 5. The payload the service worker expects

**One JSON object, all values strings** - exactly the FCM `data` map `deliver()` already builds
for each event, plus `"v": "1"`, minus `enc_payload`. The worker cannot decrypt (the keys stay in
the app's locked vault), and the encrypted body would only eat the ~4 KB budget.

`public/sw-push.js` maps it as follows (title/body the worker shows; `sender` names come from a
small address → name map the app mirrors into IndexedDB):

| `type` | fields the worker reads | shows | tag | tap opens |
|---|---|---|---|---|
| `contextual` | `sender`, `tx_id`, `inbox` | **name** / "New message" | `kachat-chat-<sender>` | that chat |
| `contextual` + `inbox:"true"` (a `dm` discovery) | `sender` | "New message request" / "kaspa:qr…abcd wants to chat with you." | `kachat-request-<sender>` | Message Requests |
| `payment` | `sender`, `amount` (sompi) | **name** / "Sent you 1.5 KAS" (else "Sent you a payment") | `kachat-chat-<sender>` | that chat |
| `handshake` | `sender` | **name** / "Started a conversation" | `kachat-chat-<sender>` | that chat |
| `group_message` | `blinded_group_id`, `sender` | **group name** / "**member**: New message" (unknown group: "Group chat" / "New group message") | `kachat-group-<groupId>` | that group |
| `group_control` | `blinded_group_id` | **group name** / "Group update" | `kachat-group-<groupId>` | that group |
| `broadcast` | `channel`, `title`, `subtitle`, `body`, `tx_id` | `#channel` / "subtitle: body" | `kachat-broadcast-<tx_id>` | that room |
| `kaposts` | `subtitle`, `body`, `post_id`, `tx_id` | "KaPosts" / "subtitle body" | `kachat-kaposts-<tx_id>` | the post |
| `name_event` | `title`, `body`, `name`, `dedup` | title / body as sent | `kachat-name-<dedup>` | .kachat |
| `address_activity` | `address`, `amount_kas`, `tx_id` | "Received 12.5 KAS" / the address's label | `kachat-addr-activity-<tx_id>` | that address |
| anything else | `title`, `body` | as sent | `kachat-push-<tx_id>` | Chats |

Optional field the worker honours on chat types: `"unread": "<n>"` - the badge to set. The service
does not know unread counts today, so leave it out; the worker then increments its own count and
the app corrects it when opened.

The tags are the ones the open app uses for its own notifications, so a push and the app's later
notification for the same message replace each other (the app's carries the real text).

Concretely, for the existing code: in each place `deliver(tokens, &payload, &data, collapse, fcm_notification)`
is called, the web transport serializes `data` (the `BTreeMap<String,String>`) with `v` added and
`enc_payload` removed. Examples:

```json
{"v":"1","type":"contextual","sender":"kaspa:qp...alice","tx_id":"ab12...","timestamp":"1792650000000","daa_score":"123","title":"kaspa:qp...alice","body":"New message"}
{"v":"1","type":"payment","sender":"kaspa:qp...alice","tx_id":"cd34...","amount":"150000000","title":"kaspa:qp...alice","body":"Payment received","timestamp":"...","daa_score":"..."}
{"v":"1","type":"contextual","inbox":"true","sender":"kaspa:qz...new","tx_id":"...","title":"...","body":"New message"}
{"v":"1","type":"group_message","sender":"kaspa:qp...bob","blinded_group_id":"9f1c...","tx_id":"...","title":"...","body":"New group message"}
{"v":"1","type":"broadcast","channel":"kaspa","title":"#kaspa","subtitle":"bob.kas","body":"gm","thread_id":"broadcast:kaspa","tx_id":"..."}
{"v":"1","type":"kaposts","title":"KaPosts","subtitle":"alice.kas","body":"liked your post","post_id":"...","kaposts_kind":"vote_up","thread_id":"kaposts","tx_id":"..."}
{"v":"1","type":"name_event","event":"offer","name":"alice","tx_id":"...","title":"New offer on alice.kachat","body":"12 KAS offered for it.","amount":"12","dedup":"offer:alice:..."}
{"v":"1","type":"address_activity","address":"kaspa:qq...","amount_sompi":"1250000000","amount_kas":"12.5","title":"Funds received","subtitle":"kaspa:qq...","body":"Received 12.5 KAS","thread_id":"funds:kaspa:qq...","tx_id":"...","ts":"..."}
```

**Never** put message plaintext in it. Broadcast and KaPosts bodies are public on-chain content
already sent in clear to APNs/FCM; keep them as they are, truncated to 1000 characters so the
encrypted record stays under the 4096-byte limit (RFC 8291 §4: the plaintext of a single record is
at most 3993 bytes; refuse to send anything larger rather than letting a push service drop it).

VoIP `Ring` events: no web equivalent (no PushKit). Skip `web` tokens for rings; the caller's
`call` message still arrives as a `contextual` push ("New message").

---

## 6. The WebPush transport in `deliver()`

### 6.1 Routing

```rust
match platforms.get(&token).map(String::as_str) {
    Some("android") => fcm_tokens.push(token),
    Some("web")     => web_tokens.push(token),   // new
    _               => apns_tokens.push(token),  // ios / macos / unknown
}
```

`push_enabled()` becomes `self.enabled && (self.apns.is_some() || self.fcm.is_some() || self.web.is_some())`.

For each web token, look up its `web_push` subscription (a `web_push_for_tokens` registry query,
like `apns_environment_for_tokens`), build the payload (§5) and send, with
`WEB_SEND_CONCURRENCY = 16`, collecting `DeliveryOutcome`s into the same `record_outcomes`.

### 6.2 Encryption and VAPID

* Content encoding **`aes128gcm`** (RFC 8291 message encryption, RFC 8188 record): ephemeral
  ECDH P-256 with the subscriber's `p256dh`, the 16-byte `auth` secret, one record.
* **VAPID** (RFC 8292): `Authorization: vapid t=<JWT ES256>, k=<public key base64url>`, JWT claims
  `aud` = the endpoint's origin (`https://web.push.apple.com`), `exp` ≤ 24 h ahead (use 12 h; cache
  the JWT per origin and renew at half-life), `sub` = `KACHAT_WEBPUSH_VAPID_SUBJECT`.
* Suggested crate: [`web-push`](https://crates.io/crates/web-push) (`WebPushMessageBuilder`,
  `ContentEncoding::Aes128Gcm`, `VapidSignatureBuilder::from_base64_no_sub` / `from_pem`), with its
  `hyper-client` (or `isahc-client`) feature; or hand-roll with `ece` + `p256`/`ring` + `jsonwebtoken`
  if the dependency tree matters. Either way unit-test against the RFC 8291 §5 example.

### 6.3 Headers, TTL, urgency, outcomes

| event `type` | `TTL` (s) | `Urgency` | `Topic` (collapse; ≤ 32 chars, base64url charset) |
|---|---|---|---|
| `contextual`, `payment`, `handshake` | 86400 | `high` | none (every message counts) |
| `group_message`, `group_control` | 86400 | `high` | none |
| `broadcast` | 3600 | `normal` | none |
| `kaposts` | 21600 | `normal` | none |
| `name_event` | 86400 | `normal` | first 32 chars of base64url(sha256(dedup)) |
| `address_activity` | 86400 | `high` | none |

Apple's endpoint requires `TTL` and `Urgency` to be present; send `Content-Encoding: aes128gcm` and
`Content-Type: application/octet-stream`.

Map responses to the existing `DeliveryOutcome`:

| status | outcome |
|---|---|
| 201 / 200 / 202 | `Delivered` |
| **404, 410** | `Unregistered` → `registry.unregister(token)` (the subscription is gone) |
| 400, 413 | `Failed` (log body; a 413 means the payload builder is wrong) |
| 401, 403 | `AuthFailed` (VAPID key / JWT problem; keep the token) |
| 429, 5xx | `Failed`; respect `Retry-After` for that origin (optional) |

The existing invalid-token counter is not needed for web (410 is definitive).

The `sent_cache` dedup, the own-sender filter, the per-device Address Activity rate limit and
KaPosts per-kind filtering all run before `deliver()` and so apply to web tokens unchanged.

---

## 7. Privacy

* The browser vendor's push service (Apple, Google, Mozilla) sees only: the endpoint, the time,
  the size and the TTL/urgency headers. The payload is end-to-end encrypted to the browser (RFC 8291)
  - the push provider cannot read it.
* The payload carries what the APNs alert and FCM data already carry: addresses, type, amount, tx
  id, and for public rooms / KaPosts their public text. **No 1:1 or group message text, no
  ciphertext**, no keys.
* The service stores the endpoint and the two subscription keys - the same class of data as an APNs
  or FCM token. Removing a registration (unregister, 404/410) must delete them.
* The endpoint is a capability URL; don't log it in full (log the last 8 characters, as for tokens).

---

## 8. Testing

1. **Unit:** `normalize_device_token` keeps an `https://` endpoint verbatim and rejects one with
   whitespace / over 2048 bytes; `normalize_platform("web")` ok; register with `platform:"web"`
   but no `web_push` → 400; `web_push.endpoint != device_token` → 400; bad `p256dh` length → 400.
2. **Preimage parity:** sign a register with the client's `buildPushAuth` (`node
   tools/test-web-push.mjs` in KaChat-Desktop prints nothing secret; its vectors pin the preimage
   lines) and verify it in a Rust test via `verify_wallet_binding_from_auth`.
3. **Encryption:** the RFC 8291 §5 vector round-trips through the chosen crate.
4. **Local end to end (testnet service):**
   * set `KACHAT_WEBPUSH_VAPID_PRIVATE_KEY` / `KACHAT_WEBPUSH_VAPID_SUBJECT`, restart;
     `curl -s https://<testnet indexer>/v1/push/web-config` → the public key;
   * open KaChat Desktop on testnet in Chrome, allow notifications; Settings > Notifications should
     read "Notifications when KaChat is closed: on"; `GET /v1/push/stats` shows `by_platform.web = 1`;
   * close the tab; send a message to that account from another device → "New message" from the
     sender's name; tap → the chat opens;
   * Chrome DevTools > Application > Service Workers > "Push" with
     `{"v":"1","type":"payment","sender":"kaspatest:...","amount":"150000000","tx_id":"x"}` tests the
     worker alone;
   * iPhone: add to Home Screen, open it, allow; lock the phone; send a message → banner, badge 1.
5. **Cleanup:** in the browser, unsubscribe (Settings > Notifications > Push Notifications off) →
   the registration disappears; or revoke the site permission → next push gets 410 → the registration
   is removed (watch `push_unregistered_removed_total`).

---

## 9. Optional follow-up

`pushsubscriptionchange` (the browser rotates the endpoint, mostly Firefox) is handled by the
client on its next start: it unregisters the old endpoint with the device key and registers the
new one. A device-key-authenticated `POST /v1/push/web-rebind {old_endpoint, web_push, auth}` would
let the service worker move the registration without the app being opened; not needed for a first
version.
