// Where Nextcloud may run. A browser page cannot reach a stock Nextcloud directly (it sends no
// CORS headers), so every Nextcloud and Talk request - the login and app password included - goes
// through the relay of the site serving this page. On a site KaChat hosts (desktop.kachat.app) that
// relay is a server someone else runs, so Nextcloud is off there. On a copy the person runs
// themselves - Kaspa Quick Start's KaChat-Desktop, or `npm run dev` - the relay is their own
// machine, and Nextcloud works. "Their own" is read from the address the page was opened at: this
// computer, or a private network address (the Quick Start machine from another device at home).

/** Where to get a KaChat that runs on your own computer. */
export const KASPA_QUICK_START_URL = "https://github.com/KaspaSilver/Kaspa-Quick-Start";

function ipv4Parts(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Whether `hostname` is this computer or a private network address. */
export function isLocalHostname(hostname) {
  let host = String(hostname || "").trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // mDNS and home-router names never resolve on the public internet.
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa") || host.endsWith(".internal")) return true;
  const v4 = ipv4Parts(host);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) // link-local
      || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT range, used by Tailscale and the like
  }
  if (host.includes(":")) {
    if (host === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isLocalHostname(mapped[1]);
    return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host); // unique-local, link-local
  }
  return false;
}

/**
 * Why Nextcloud is off on this page, or null when it may run:
 * - "testnet": off on testnet (iOS af8ec68), so testnet can never touch the mainnet backup;
 * - "hosted": this page is served by a site, not run on your own computer, so the login would
 *   pass through that site's relay.
 */
export function nextcloudOffReason({ testnet = false, hostname = "" } = {}) {
  if (testnet) return "testnet";
  if (!isLocalHostname(hostname)) return "hosted";
  return null;
}
