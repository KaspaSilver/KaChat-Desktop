// Mainnet / testnet (iOS 5.2: Settings > Connection > Testnet).
//
// The network is chosen in Settings and read ONCE, when the page loads: the node connection, the
// wallet address, every endpoint and all per-account data are set up for it then, so a switch
// takes effect on the next load (iOS: "close KaChat completely and open it again"). Everything
// below is therefore a constant for the life of the page.
//
// Testnet means testnet-10 (iOS a67a1c2): it carries the Toccata covenants .kachat names test on,
// and its public REST API is api-tn10.kaspa.org.

const NETWORK_KEY = "kachat-network-v1";

function readStoredNetwork() {
  try { return localStorage.getItem(NETWORK_KEY) === "testnet" ? "testnet" : "mainnet"; }
  catch { return "mainnet"; }
}

/** The network this page is running on: "mainnet" | "testnet". */
export const NETWORK = readStoredNetwork();
export const IS_TESTNET = NETWORK === "testnet";
/** The Rusty Kaspa network id for the running network. */
export const NETWORK_ID = IS_TESTNET ? "testnet-10" : "mainnet";
/** The address prefix (HRP) of the running network, without the colon. */
export const ADDRESS_HRP = IS_TESTNET ? "kaspatest" : "kaspa";
export const ADDRESS_PREFIX = `${ADDRESS_HRP}:`;
/** The unit amounts are shown in: KAS on mainnet, TKAS on testnet (iOS KaspaUnit), so a testnet
 *  amount can never be read as real KAS. Market data (the KAS price) stays "KAS". */
export const KAS_UNIT = IS_TESTNET ? "TKAS" : "KAS";

/** The network the user picked in Settings - may differ from NETWORK until the next load. */
export function preferredNetwork() { return readStoredNetwork(); }
export function setPreferredNetwork(network) {
  try {
    if (network === "testnet") localStorage.setItem(NETWORK_KEY, "testnet");
    else localStorage.removeItem(NETWORK_KEY);
  } catch { /* storage blocked: the switch cannot persist */ }
}

/** The network an address names by its prefix, or null for none. */
export function networkOfAddress(address) {
  const lower = String(address || "").trim().toLowerCase();
  if (lower.startsWith("kaspatest:")) return "testnet";
  if (lower.startsWith("kaspa:")) return "mainnet";
  return null;
}
/** A Kaspa address of the running network. */
export function isNetworkAddress(address) {
  return String(address || "").trim().toLowerCase().startsWith(ADDRESS_PREFIX);
}
/** False only for an address that names the OTHER network (iOS NetworkType.isOnActiveNetwork):
 *  one key is one account on both networks, so such a message would decrypt fine and land in the
 *  wrong network's chats. */
export function isOnActiveNetwork(address) {
  const network = networkOfAddress(address);
  return network == null || network === NETWORK;
}
/** Replaces the KAS unit word in already-built text with TKAS on testnet - only as a whole ASCII
 *  word, so "Kaspa" and an existing "TKAS" are untouched. */
export function kasLabel(text) {
  const value = String(text ?? "");
  return IS_TESTNET ? value.replace(/(?<![A-Za-z])KAS(?![A-Za-z])/g, "TKAS") : value;
}

// --- Address re-encoding (one key, one address per network) -----------------------------------
// Kaspa addresses are cashaddr: <hrp>:<base32 payload><8-char checksum>, and the checksum covers
// the hrp. Re-encoding swaps the hrp and recomputes the checksum; the payload is unchanged.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i += 1) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i];
  }
  return c ^ 1n;
}

function checksumChars(hrp, data5) {
  const prefix = Array.from(hrp, (ch) => ch.charCodeAt(0) & 0x1f);
  const value = polymod([...prefix, 0, ...data5, 0, 0, 0, 0, 0, 0, 0, 0]);
  let out = "";
  for (let i = 7; i >= 0; i -= 1) out += CHARSET[Number((value >> BigInt(i * 5)) & 31n)];
  return out;
}

/** Whether `address` carries a valid checksum for its own prefix. */
export function isValidKaspaAddress(address) {
  const lower = String(address || "").trim().toLowerCase();
  const colon = lower.indexOf(":");
  if (colon < 1) return false;
  const hrp = lower.slice(0, colon);
  const body = lower.slice(colon + 1);
  if (body.length < 9 || [...body].some((ch) => !CHARSET.includes(ch))) return false;
  const data5 = Array.from(body.slice(0, -8), (ch) => CHARSET.indexOf(ch));
  return checksumChars(hrp, data5) === body.slice(-8);
}

/** The same key's address with another prefix ("kaspa" | "kaspatest"); the input unchanged when
 *  it is not a well-formed address. */
export function reencodeAddress(address, hrp) {
  const lower = String(address || "").trim().toLowerCase();
  const colon = lower.indexOf(":");
  if (colon < 1) return address;
  if (lower.slice(0, colon) === hrp) return lower;
  const body = lower.slice(colon + 1);
  if (body.length < 9 || [...body].some((ch) => !CHARSET.includes(ch))) return address;
  const payload = body.slice(0, -8);
  return `${hrp}:${payload}${checksumChars(hrp, Array.from(payload, (ch) => CHARSET.indexOf(ch)))}`;
}
/** The address on the running network. */
export function toActiveNetworkAddress(address) { return reencodeAddress(address, ADDRESS_HRP); }
/** The mainnet encoding - the account's identity, the same whichever network is running. */
export function canonicalAccountAddress(address) { return reencodeAddress(address, "kaspa"); }
/** Same key, either network. */
export function sameAccountAddress(a, b) {
  if (!a || !b) return false;
  return canonicalAccountAddress(a) === canonicalAccountAddress(b);
}
