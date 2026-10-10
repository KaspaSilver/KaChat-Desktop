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

export function isPubliclyOpen(nowMs = Date.now(), network = NETWORK_ID) {
  const opens = publicLaunchMs(network);
  return opens == null || nowMs >= opens;
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
