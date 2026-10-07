// .kachat names: the profile cache - what this device knows about people's profiles.
//
// Port of iOS KachatProfileCache (KaChat/Services/KachatNames/KachatNamesRegistry.swift, 5e408f7).
// Two parts, both rebuilt on demand, so both are cache (Settings > Storage > Cache > Profiles
// measures and clears everything under `profileCachePrefix`):
//
// - identities: who each address is - `{ address, label, names, profile }` - per network, at most
//   `profileIdentitiesMax` (1000) people, the least recently confirmed dropped first. Loaded at
//   launch marked stale (`stale: true`), so avatars and bios show at once and are fetched again
//   in the background. Written with a debounce (`ProfileIdentityStore.schedule`).
// - the social lookups (avatar, banner and bio from each link): social-image-resolver.js, under
//   `profileCacheSocialPrefix` (`socialImageCachePrefix`), migrated once from its old keys.
//
// This device's own saved profile record (`ownProfileStorageKey`, "kachat-names-profile-<network>-
// v1:<address>") is NOT cache and is not under this prefix: clearing the cache never touches it.
//
// Profiles are not registry data, so this works on every network; each network keeps its own
// identities (`profileIdentitiesKey(network)`), so a network switch never shows the other one's.
//
// Shared with the browser-extension repo, which copies engine/kachat-names/*: every I/O
// dependency is injected, there are no app imports, and nothing runs at import.
//
// STORAGE (`storage: { get(key) -> string|null, set(key, string), remove?(key) }`, sync):
//   "kachat-profile-cache-v1:identities:<network>"   (network "mainnet" | "testnet")
//     {"v":1,"network":"<network>","entries":[[address, label|null, [names], profile|null, at], ...]}
//     address lowercased; profile the record as Profile.toJSON() gives it; at = unix ms the
//     identity was last confirmed by a lookup. Oldest `at` first out past the bound.
//   "kachat-profile-cache-v1:social:<link>" / "kachat-profile-cache-v1:social:index"
//     the social lookups (social-image-resolver.js).
//
// API:
//   profileCachePrefix, profileCacheSocialPrefix, profileIdentitiesMax, profileCachePersistDelayMs
//   profileIdentitiesKey(network) -> string
//   encodeProfileIdentities(network, entries, { max }) -> string
//     entries: iterable of [address, { identity, at }] (identity null = nothing known: skipped)
//   decodeProfileIdentities(network, text, { max }) -> Map<address, { identity, at, stale: true }>
//     identity: { address, label, names, profile: Profile|null } (profile sanitized); anything
//     malformed, empty or of the other network is dropped.
//   new ProfileIdentityStore({ storage, network, entries: () => iterable, max, delayMs,
//                              setTimer, clearTimer })
//     store.load() -> Map (as decodeProfileIdentities)   store.schedule()   store.flush()
//     store.clear()   store.pending -> boolean

import { Profile } from "./registry-state.js";

/** Every key of the profile cache starts with this. */
export const profileCachePrefix = "kachat-profile-cache-v1:";
/** The social lookups' key prefix (social-image-resolver.js `socialImageCachePrefix`). */
export const profileCacheSocialPrefix = `${profileCachePrefix}social:`;
/** At most this many people's identities are kept per network (iOS identitiesKeep). */
export const profileIdentitiesMax = 1000;
/** A change is written this long after it happened (more changes in between join it). */
export const profileCachePersistDelayMs = 2_000;

const networks = new Set(["mainnet", "testnet"]);
const hrpOf = { mainnet: "kaspa:", testnet: "kaspatest:" };
const maxTextLength = 4_000_000;

function checkedNetwork(network) {
  const n = String(network ?? "");
  if (!networks.has(n)) throw new TypeError(`unknown network "${n}"`);
  return n;
}

/** The storage key of a network's cached identities. */
export function profileIdentitiesKey(network) {
  return `${profileCachePrefix}identities:${checkedNetwork(network)}`;
}

function cleanAddress(network, address) {
  const a = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!a || a.length > 128 || !a.startsWith(hrpOf[network]) || !/^[a-z]+:[a-z0-9]+$/.test(a)) return null;
  return a;
}

function cleanText(v, max) {
  return typeof v === "string" && v && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : null;
}

function profileJSON(profile) {
  if (profile == null) return null;
  try {
    const p = (profile instanceof Profile ? profile : new Profile(profile)).sanitized().toJSON();
    return Object.keys(p).length ? p : null;
  } catch {
    return null;
  }
}

/** The identity as stored, or null when there is nothing worth keeping. */
function storedIdentity(network, address, identity) {
  if (!identity || typeof identity !== "object") return null;
  const a = cleanAddress(network, address);
  if (!a) return null;
  const label = cleanText(identity.label, 64);
  const names = Array.isArray(identity.names) ? identity.names.map((n) => cleanText(n, 64)).filter(Boolean).slice(0, 50) : [];
  const profile = profileJSON(identity.profile);
  if (!label && names.length === 0 && !profile) return null;
  return [a, label, names, profile];
}

/** The newest `max` of `rows` ([..., at] last), oldest first out. */
function newest(rows, max) {
  if (rows.length <= max) return rows;
  return [...rows].sort((x, y) => y[y.length - 1] - x[x.length - 1]).slice(0, max);
}

/** A network's identities as stored: at most `max`, the least recently confirmed dropped. */
export function encodeProfileIdentities(network, entries, { max = profileIdentitiesMax } = {}) {
  const n = checkedNetwork(network);
  const rows = [];
  for (const [address, entry] of entries ?? []) {
    const at = Number(entry?.at);
    if (!Number.isFinite(at) || at < 0) continue;
    const row = storedIdentity(n, address, entry?.identity);
    if (row) rows.push([...row, Math.floor(at)]);
  }
  return JSON.stringify({ v: 1, network: n, entries: newest(rows, Math.max(0, max)) });
}

/** The identities stored for `network`, each marked stale (shown at once, looked up again). */
export function decodeProfileIdentities(network, text, { max = profileIdentitiesMax } = {}) {
  const n = checkedNetwork(network);
  const out = new Map();
  if (typeof text !== "string" || !text || text.length > maxTextLength) return out;
  let j = null;
  try { j = JSON.parse(text); } catch { return out; }
  if (!j || j.v !== 1 || j.network !== n || !Array.isArray(j.entries)) return out;
  const rows = [];
  for (const e of j.entries) {
    if (!Array.isArray(e) || e.length !== 5) continue;
    const at = Number(e[4]);
    if (!Number.isFinite(at) || at < 0) continue;
    const row = storedIdentity(n, e[0], { label: e[1], names: e[2], profile: e[3] && typeof e[3] === "object" && !Array.isArray(e[3]) ? e[3] : null });
    if (row) rows.push([...row, at]);
  }
  for (const [address, label, names, profile, at] of newest(rows, Math.max(0, max))) {
    if (out.has(address)) continue;
    out.set(address, {
      identity: { address, label, names, profile: profile ? new Profile(profile).sanitized() : null },
      at,
      stale: true,
    });
  }
  return out;
}

/** One network's identities in `storage`, written a moment after they change. */
export class ProfileIdentityStore {
  constructor({
    storage, network, entries, max = profileIdentitiesMax, delayMs = profileCachePersistDelayMs,
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
  } = {}) {
    this.network = checkedNetwork(network);
    this.key = profileIdentitiesKey(this.network);
    this.storage = storage ?? null;
    this.entries = typeof entries === "function" ? entries : () => [];
    this.max = max;
    this.delayMs = delayMs;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._timer = null;
  }

  /** Whether a write is waiting. */
  get pending() { return this._timer != null; }

  /** The stored identities, each marked stale. */
  load() {
    let text = null;
    try { text = this.storage?.get(this.key) ?? null; } catch { text = null; }
    return decodeProfileIdentities(this.network, text, { max: this.max });
  }

  /** Writes the identities `delayMs` from now (a write already waiting covers this change). */
  schedule() {
    if (this._timer != null || !this.storage) return;
    this._timer = this._setTimer(() => { this._timer = null; this._write(); }, this.delayMs);
  }

  /** Writes a waiting change now. */
  flush() {
    if (this._timer == null) return;
    this._clearTimer(this._timer);
    this._timer = null;
    this._write();
  }

  /** Forgets the stored identities (a waiting write is dropped). */
  clear() {
    if (this._timer != null) { this._clearTimer(this._timer); this._timer = null; }
    try {
      if (typeof this.storage?.remove === "function") this.storage.remove(this.key);
      else this.storage?.set(this.key, "");
    } catch { /* blocked */ }
  }

  _write() {
    let text;
    try { text = encodeProfileIdentities(this.network, this.entries(), { max: this.max }); } catch { return; }
    try { this.storage?.set(this.key, text); } catch { /* full or blocked: memory only this run */ }
  }
}
