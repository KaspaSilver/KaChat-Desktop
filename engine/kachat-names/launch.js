// Mainnet's public opening, the owner's launch plan (kachat-domains docs/MAINNET.md, iOS c6ebf74
// KachatNamesService.publicLaunchMs): until then the marketplace shows a countdown and nobody
// searches or claims names in the app. The registry itself is open from its genesis; this gates
// the app only. Names already held stay manageable meanwhile. Testnet never has a countdown.

import { NETWORK_ID } from "../network.js";

/** Friday 2026-10-16, 8:00 AM Eastern (12:00 UTC). */
export const MAINNET_PUBLIC_LAUNCH_MS = 1_792_152_000_000;

/** When this network's names open to everyone in the app; null once there is no countdown. */
export function publicLaunchMs(network = NETWORK_ID) {
  return network === "mainnet" ? MAINNET_PUBLIC_LAUNCH_MS : null;
}

// The countdown runs on the network's clock, not the device's (XP-020): a device set to a later
// date must not open search and registration early, nor a slow one keep them shut. The node's past
// median time is noted whenever the app reads the DAG (engine.currentDagPoint) and carried forward
// with a monotonic timer, which changing the device's date does not move.
const monotonicMs = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
let chainClock = null; // { chainMs, at }
let chainTimeSource = null;
let chainTimeRefresh = null;
let chainTimeTriedAt = -Infinity;

/** A node's past median time (unix ms), as just read. */
export function noteChainTimeMs(ms) {
  const chainMs = Number(ms);
  if (!Number.isFinite(chainMs) || chainMs <= 0) return;
  chainClock = { chainMs, at: monotonicMs() };
}

/** The network's time now, or null before any node has answered. */
export function networkNowMs() {
  return chainClock ? chainClock.chainMs + (monotonicMs() - chainClock.at) : null;
}

/** What reads the DAG when the countdown needs the network's time (the app's engine). */
export function setChainTimeSource(read) {
  chainTimeSource = typeof read === "function" ? read : null;
}

/** Reads the network's time again when it's unknown or older than `maxAgeMs`; never throws. */
export async function refreshChainTime({ read = chainTimeSource, maxAgeMs = 60_000 } = {}) {
  if (chainClock && monotonicMs() - chainClock.at < maxAgeMs) return networkNowMs();
  if (!read) return networkNowMs();
  if (!chainTimeRefresh) {
    // no node answering: ask again at most every 5 s, not on every countdown tick
    if (monotonicMs() - chainTimeTriedAt < 5_000) return networkNowMs();
    chainTimeTriedAt = monotonicMs();
    chainTimeRefresh = (async () => {
      try {
        const dag = await read();
        if (dag?.pastMedianTime != null) noteChainTimeMs(dag.pastMedianTime);
      } catch { /* no node yet: stays unknown */ }
      chainTimeRefresh = null;
    })();
  }
  await chainTimeRefresh;
  return networkNowMs();
}

// Once the network has passed the opening it stays open - its clock only moves forward - so that
// is remembered and later visits don't flash the countdown (iOS 6975e3e).
const openedKey = (network) => `kachat_names_public_opened.${network}`;
function rememberedOpen(network) {
  try { return globalThis.localStorage?.getItem(openedKey(network)) === "1"; } catch { return false; }
}
function rememberOpen(network) {
  try { globalThis.localStorage?.setItem(openedKey(network), "1"); } catch { /* fine */ }
}

/** Open once the network's time reaches the opening (iOS 6975e3e, XP-020); closed while that time
 *  is unknown. `nowMs` defaults to the network's time - never the device's. */
export function isPubliclyOpen(nowMs = undefined, network = NETWORK_ID) {
  const opens = publicLaunchMs(network);
  if (opens == null) return true;
  if (rememberedOpen(network)) return true;
  const fromNetwork = nowMs === undefined;
  const now = fromNetwork ? networkNowMs() : nowMs;
  if (now == null || now < opens) return false;
  if (fromNetwork) rememberOpen(network); // only the network's own time is remembered
  return true;
}

/** "Friday, October 16 at 8:00 AM" in the person's own time zone and language (iOS launchString). */
export function launchString(ms, locale = undefined) {
  const d = new Date(Number(ms));
  try {
    return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
  } catch {
    return d.toString();
  }
}
