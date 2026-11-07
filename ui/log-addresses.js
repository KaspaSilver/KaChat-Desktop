// Addresses in log lines (iOS d23e6f7a AppLog.shortenAddresses, KaPay 1652437): every full Kaspa
// address in a line is cut to "…" and its last 8 characters, wherever it came from (a message, a
// URL, a storage key name), so no caller has to remember. The diagnostics export carries the log,
// and the person sharing it shouldn't be handing out every address they and their contacts use.

// `kaspa:`, `kaspatest:` (and the sim/dev prefixes), or the `_` form used in keys and file names.
const ADDRESS_PATTERN = /\b(?:kaspa|kaspatest|kaspasim|kaspadev)[:_]([a-z0-9]{12,})/gi;

/** `line` with every full address shortened to "…" + its last 8 characters. */
export function shortenLogAddresses(line) {
  return String(line ?? "").replace(ADDRESS_PATTERN, (_match, payload) => `…${payload.slice(-8)}`);
}
