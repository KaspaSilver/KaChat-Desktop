import { NETWORK_ID, ADDRESS_PREFIX, IS_TESTNET, otherNetworkReason } from "./network.js";

// The running network (engine/network.js): fixed for the life of the page.
export { NETWORK_ID };

export function stringify(value) {
  try {
    return typeof value === "string"
      ? value
      : JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2);
  } catch {
    return String(value);
  }
}

export function requireKaspa(kaspa) {
  if (!kaspa) throw new Error("Load Rusty Kaspa WASM first.");
}

export function validatePrivateKeyHex(hex) {
  const clean = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("Private key must be 64 hex characters.");
  }
  return clean;
}

/** A destination on the running network (the name predates testnet support). */
export function validateMainnetAddress(address) {
  const clean = String(address || "").trim();
  if (!clean.toLowerCase().startsWith(ADDRESS_PREFIX)) {
    // The other network's address names the same key on another chain (IOS-003): say so.
    const reason = otherNetworkReason(clean);
    if (reason) throw new Error(reason);
    throw new Error(IS_TESTNET ? "Destination must be a testnet kaspatest: address." : "Destination must be a mainnet kaspa: address.");
  }
  return clean;
}

export function sompiToKaspaDisplay(kaspa, totalSompi) {
  if (kaspa?.sompiToKaspaString) return kaspa.sompiToKaspaString(totalSompi);
  const s = totalSompi.toString().padStart(9, "0");
  return `${s.slice(0, -8) || "0"}.${s.slice(-8).replace(/0+$/, "") || "0"}`;
}
