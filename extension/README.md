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
| `popup.html`, `src/popup.js` | Boot and the home screen (the iOS Profile tab). The same page opens as a full tab with `?view=tab` (the expand button), and as the website approval window with `?view=approve`. |
| `src/onboarding.js` | The accounts screen (Saved Accounts), Create Account, Import Account (iOS source-wallet list, word grid, passphrase), unlock and reset. |
| `src/send.js`, `src/manage.js` | Send Kaspa (fees, Max, coin control, Sent sheet) and the Manage screens (history, UTXOs, keys, spending addresses, Change Chatting Address). |
| `src/domains.js` | Your Domains: a tab per name service (.kachat, .kas, .k, .kaspa) with "Get a domain" links; .kas Set as Primary (signed KNS API call) and Send Domain (commit/reveal transfer). |
| `src/names.js`, `src/names-normalize.js` | The name services (port of iOS NameServices.swift): names an address owns on .k / .kaspa, resolving a typed name on every service, the "Other domains" picker. The normalizers are checked against the dotk and Kaspa Names SDK vectors: `node tools/check-name-vectors.mjs`. |
| `src/settings.js` | Settings: currency, auto-lock, change password, connection, explorer, connected sites, View Seed Phrase, licenses. |
| `src/approve.js` | The approval window for website requests: connect, send Kaspa, sign message. |
| `src/ui.js` | Shared rendering helpers, icons, sheets, the password gate, the QR screen. |
| `src/vault.js` | The encrypted vault: every account's recovery phrase sealed with the wallet password (PBKDF2-SHA256, 600,000 rounds, then AES-256-GCM). Nothing secret is stored unencrypted. |
| `src/wallet.js` | Kaspa WASM, address derivation, node connection, balances, sends, history, KNS - thin wrappers over `../engine`. |
| `src/background.js` | Auto-lock (a one-shot alarm re-armed by activity) and the website-connect broker. |
| `public/inpage.js`, `public/content.js` | `window.kachat` in web pages, and the content script that relays its calls to the background. |
| `public/manifest.json` | Manifest V3. `wasm-unsafe-eval` in the CSP lets the Kaspa WASM compile. `tools/ext-package.mjs` derives the Firefox manifest from it. |

The wallet runs in the popup and tab pages, not the background worker: they have the DOM,
`localStorage` and a steady WebSocket, which the shared engine expects. The unlock key lives in
`storage.session` (memory only, extension pages only), so closing the browser or the auto-lock
locks the wallet.

## Website connect (for Kaspa site developers)

KaChat Wallet puts `window.kachat` on every https page (and localhost). Names follow KasWare's
where they overlap. Listen for `kachat#initialized` if your script can run first.

```js
const [address] = await window.kachat.requestAccounts();       // asks the user to connect
await window.kachat.getAccounts();                              // [] until connected + unlocked
await window.kachat.getNetwork();                               // "mainnet"
await window.kachat.getPublicKey();                             // compressed public key hex
await window.kachat.getBalance();                               // { confirmed, unconfirmed, total } in sompi
const txid = await window.kachat.sendKaspa(to, 150000000, { priorityFee: 0 });  // asks the user
const signature = await window.kachat.signMessage("hello");    // asks the user
await window.kachat.disconnect();
window.kachat.on("accountsChanged", (accounts) => {});
window.kachat.on("disconnect", () => {});
```

Errors carry a `code`: `4001` rejected by the user, `4100` not connected, `4200` unsupported
method, `-32002` a request from this site is already waiting, `-32602` bad parameters, `4900`
wallet unavailable. The address a site sees is the chosen account's chatting address
(`m/44'/111111'/0'/0/0` for most wallets - the same address KasWare shows for that phrase);
`signMessage` is the Kaspa wallet message standard (Schnorr over the
`PersonalMessageSigningHash`-keyed blake2b of the message).

## Store packages

```
npm run ext:package      # ext:build, then extension/dist-firefox and extension/packages/*.zip
```

Upload notes and review answers for each store are in `STORE_LISTING.md`.

## Addresses

| Name here | KaChat name | Path |
|---|---|---|
| Main address | Chatting address (identity, KNS domains) | `m/44'/111111'/0'/0/0` (or the imported wallet's family) |
| Spending address | Spending address | `m/44'/111111'/1'/0/{index}` |

## Roadmap

1. Foundation - create/import/unlock/lock, vault, network, balances, receive. **(done)**
2. Send, fees, Max, KNS name lookup, Manage Addresses, history, compound, coin control. **(done)**
3. KNS domains: list, set primary, transfer. No inscribing and no profile creation or
   editing - profiles move to .kachat names, which are not built yet. **(done)**
4. iOS import flow, several accounts, Settings (currency, auto-lock, change password, view
   phrase, nodes and APIs, explorer), Open Source Licenses. **(done)**
5. Firefox build, store packaging, privacy policy, listing text. **(done - submitting is yours)**
6. Website connect: `window.kachat` with approvals for connect, send and sign. **(done)**

Next ideas: KRC-20 tokens, a light theme and languages (iOS Appearance / Language), KNS domains
on spending addresses (iOS Manage Addresses > KNS Domains tab).
