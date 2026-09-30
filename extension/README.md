# KaChat Wallet (browser extension)

A Kaspa wallet for Chrome, Brave, Edge and other Chromium browsers (Firefox build to follow),
built on the desktop app's wallet engine. It is the wallet half of KaChat - the Profile tab of
the iOS app - without chats. The same recovery phrase shows the same addresses as KaChat on
iOS, Android and desktop.

## Build and load

```
npm install              # once, from the repo root
npm run ext:build        # builds extension/dist
```

Then in the browser:

1. Open `chrome://extensions` (Brave: `brave://extensions`, Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** and pick the `extension/dist` folder.

While working on it, `npm run ext:watch` rebuilds on every save; press the reload arrow on the
extension's card to pick up the new build.

## How it is put together

| Piece | What it does |
|---|---|
| `popup.html`, `src/popup.js` | The whole wallet UI. The same page opens as a full tab with `?view=tab` (the expand button). |
| `src/vault.js` | The encrypted vault: recovery phrases sealed with the wallet password (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). Nothing secret is stored unencrypted. |
| `src/wallet.js` | Kaspa WASM, address derivation, node connection, balances, price - thin wrappers over `../engine`. |
| `src/background.js` | Auto-lock only (a one-shot alarm re-armed by activity). Website connect comes here later. |
| `public/manifest.json` | Manifest V3. `wasm-unsafe-eval` in the CSP lets the Kaspa WASM compile. |

The wallet runs in the popup and tab pages, not the background worker: they have the DOM,
`localStorage` and a steady WebSocket, which the shared engine expects. The unlock key lives in
`storage.session` (memory only, extension pages only), so closing the browser or the auto-lock
locks the wallet.

## Addresses

| Name here | KaChat name | Path |
|---|---|---|
| Main address | Chatting address (identity, KNS domains) | `m/44'/111111'/0'/0/0` (or the imported wallet's family) |
| Spending address | Spending address | `m/44'/111111'/1'/0/{index}` |

## Roadmap

1. Foundation - create/import/unlock/lock, vault, network, balances, receive. **(done)**
2. Send, fees, Max, KNS name lookup, Manage Addresses, history, compound, coin control.
3. KNS: domains, set primary, transfer, inscribe, profile editor.
4. Settings (currency, auto-lock, change password, view phrase, nodes and APIs), multiple
   accounts, Firefox build, store packaging.
5. Website connect: permissioned signing and sending for dApps.
