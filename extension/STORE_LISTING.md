# KaChat Wallet - store listing and review answers

Everything the Chrome Web Store, Microsoft Edge Add-ons and Firefox Add-ons (AMO) forms ask for,
ready to paste. Build the upload files with `npm run ext:package` (see README.md).

| Store | Upload | Developer dashboard |
|---|---|---|
| Chrome Web Store (also Brave, Opera, Vivaldi, Arc) | `extension/packages/kachat-wallet-<version>-chromium.zip` | https://chrome.google.com/webstore/devconsole |
| Microsoft Edge Add-ons | the same chromium zip | https://partner.microsoft.com/dashboard/microsoftedge |
| Firefox Add-ons | `kachat-wallet-<version>-firefox.zip`, plus `kachat-wallet-<version>-source.zip` when asked for source code | https://addons.mozilla.org/developers/ |

Privacy policy URL (all stores): **https://kachat.app/wallet-privacy.html** - live once the
kachat.app link site is redeployed with `web_site/wallet-privacy.html` (KaChat repo).

## Listing

**Name:** KaChat Wallet

**Summary (Chrome, max 132 characters):**
Kaspa wallet by KaChat. Send and receive KAS, manage addresses and domains, and connect to Kaspa websites.

**Category:** Chrome: Productivity > Tools (or "Workflow & Planning"; there is no finance category).
Firefox: Privacy & Security is wrong for this - use "Other". Edge: Productivity.

**Description:**

KaChat Wallet brings the wallet from the KaChat app to your browser. Your recovery phrase opens
the same addresses as KaChat on iPhone, Android and desktop.

- Create a new account or import one from KaChat, KasWare, Kaspium, Kastle, KDX, OKX, OneKey,
  Ledger or the Kaspa CLI wallet
- Send and receive Kaspa, with .kas name lookup, Max, coin control and Normal / Fast / Priority fees
- A fresh receiving address every time, and Manage Addresses for your spending addresses:
  generate, discover, rename, hide, set the primary, and send everything to it
- History, coins (UTXOs) and Compound for every address
- Your domains on every Kaspa name service (.kas, .k, .kaspa), with .kachat names on the way:
  set your primary .kas name and send a .kas domain to someone else
- Send to a name on any service - and pick another service's answer under "Other domains"
- Cold Storage: watch a KasSigner account by its kpub and send from it by signing on the device - the transaction goes out and the signature comes back as animated QR codes
- Portfolio: up to five portfolios of buys and sells, price and value charts, profit and loss, network hashrate, CSV import/export, and import from any Kaspa address
- Several accounts in one wallet
- Connect to Kaspa websites: they ask, you approve every connection, payment and signature
- Your recovery phrase is encrypted with your password and never leaves your computer
- No accounts, no tracking, no ads

KaChat Wallet is self-custody: only you hold your keys. Keep your recovery phrase written down and
safe - it is the only way to restore your wallet.

## Chrome Web Store: Privacy practices tab

**Single purpose:** A Kaspa cryptocurrency wallet: hold keys locally, show balances, send and
receive Kaspa, manage KNS domains, and let Kaspa websites request payments and signatures with
the user's approval.

**Permission justifications:**

- `storage` - Stores the password-encrypted wallet (recovery phrases), account names, derived
  public addresses, settings and connected websites in the browser.
- `alarms` - Locks the wallet automatically after the auto-lock time the user chooses.
- Host permission `api.kaspa.org` - Kaspa REST API: transaction history and address usage.
- Host permissions `*.kaspa.green`, `*.kaspa.red`, `*.kaspa.stream`, `*.kaspa.blue`, `*.kaspa.ws` -
  the public Kaspa node resolver and nodes, for balances and sending transactions.
- Host permission `api.knsdomains.org` - Kaspa Name Service: the .kas domains an address owns,
  name lookups, setting the primary domain.
- Host permissions `api.dotk.name`, `kaspaname.com` - the .k (dotk) and .kaspa (Kaspa Names)
  name services, read-only: the names an address owns and name lookups.
- Host permission `api.coingecko.com` - the Kaspa price in the user's currency and the Portfolio's price history.
- Host permissions `api.gateio.ws`, `query1.finance.yahoo.com` - Portfolio: long-range KAS price history (fallback) and the comparison charts (VOO, gold, silver).
- Content scripts on `https://*/*` (and localhost) - provide `window.kachat`, the interface Kaspa
  websites use to ask the wallet for a connection, payment or signature. The scripts only relay
  those requests; they do not read or change page content. Every request needs the user's
  approval in the wallet.
- Optional host permission `https://*/*` - requested only when the user sets a custom Kaspa REST
  API in Settings, for that one address.

**Remote code:** No. All code, including the Kaspa WebAssembly module, is in the package.
(`wasm-unsafe-eval` in the CSP lets the bundled WebAssembly compile; nothing is fetched and run.)

**Data usage:** The developer collects no user data. Public Kaspa addresses are sent to the
Kaspa network and the APIs above to show balances and send transactions - the user's own
requests to third-party services, not collection by the developer. If the form insists on a
category, the closest is "Financial and payment information" (blockchain addresses), with "not
sold", "not used for unrelated purposes" and "not used for creditworthiness" all certified.
Your call - review it before submitting.

## Firefox Add-ons

- **Add-on ID:** `wallet@kachat.app` (in the Firefox manifest; do not change it after the first
  upload).
- **Minimum Firefox:** 128 (needs `world: "MAIN"` content scripts and `storage.session`).
- **Data collection declaration:** `none` (in the manifest's `data_collection_permissions`).
- **Source code:** AMO asks for it because the upload is bundled/minified. Upload the source zip
  and paste these build notes:

  > Requirements: Node.js 20+ and npm. From the repository root: `npm install`, then
  > `npm run ext:package`. The Firefox build is `extension/dist-firefox/`; the zip is
  > `extension/packages/kachat-wallet-<version>-firefox.zip`. `kaspa/kaspa.js` and
  > `kaspa/kaspa_bg.wasm` are the rusty-kaspa WASM SDK (ISC licence), committed prebuilt;
  > `npm run setup:wasm` rebuilds them from source.

## Screenshots

Stores want 1280x800 (Chrome) or at least 600px wide (Firefox). Open the wallet as a tab
(the expand button) at that window size and capture: the Profile home screen, Send Kaspa, Manage
Addresses, Your Domains, and a website approval window.
