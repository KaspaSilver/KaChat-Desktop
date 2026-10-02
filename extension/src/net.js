// The running network - mainnet or testnet-10 - for the extension. engine/network.js decides it
// once per page from localStorage "kachat-network-v1" (iOS: a switch takes effect on the next
// launch; the extension reloads its pages at once instead). The extension adds:
//   netKey()      per-network storage keys (iOS keeps balances, spending state, cold storage,
//                 portfolios and the node list apart per network)
//   a mirror of the choice in chrome.storage.local ("kachat.network"), because the background
//   worker has no localStorage and must know which network a website is talking to
//   testnet endpoint defaults, used until engine/endpoints.js answers per network itself

export * from "../../engine/network.js";
import { IS_TESTNET, NETWORK, preferredNetwork, setPreferredNetwork } from "../../engine/network.js";
import { getLocal, setLocal } from "./browser.js";

export const NETWORK_MIRROR_KEY = "kachat.network";

/** A storage key for the running network: unchanged on mainnet (existing data stays put),
 *  ".testnet" appended on testnet. */
export function netKey(base) {
  return IS_TESTNET ? `${base}.testnet` : base;
}

export const MAINNET_REST = "https://api.kaspa.org";
export const TESTNET_REST = "https://api-tn10.kaspa.org";
export const MAINNET_KNS = "https://api.knsdomains.org/mainnet/api/v1";
export const TESTNET_KNS = "https://api.knsdomains.org/tn10/api/v1";

/** Switches the network and keeps the worker's mirror in step. Pages reload to apply it. */
export async function switchNetwork(network) {
  setPreferredNetwork(network);
  await setLocal(NETWORK_MIRROR_KEY, network === "testnet" ? "testnet" : "mainnet");
}

/** On boot: the mirror follows the page's choice (localStorage is the source of truth). */
export async function syncNetworkMirror() {
  const stored = await getLocal(NETWORK_MIRROR_KEY);
  const current = preferredNetwork();
  if (stored !== current) await setLocal(NETWORK_MIRROR_KEY, current);
  return NETWORK;
}
