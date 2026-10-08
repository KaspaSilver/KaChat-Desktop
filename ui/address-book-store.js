// The Address Book's data (iOS AddressBookManager, 00767a4 + cda0d99): saved Kaspa addresses with
// a name, a note and optionally a photo you assigned, one book per wallet. No DOM in here, so
// tools/test-address-book.mjs runs it under node; the screens are ui/address-book.js.
//
// Storage (per wallet, every key goes through the host's accountScopedKey):
//   - ENTRIES_KEY  (localStorage): JSON array of { id, address, name, note, createdAt, updatedAt },
//     times in ms, addresses lowercase with no ?query;
//   - DELETED_KEY  (localStorage): JSON array of { address, deletedAt } tombstones, so a backup
//     merge from another device never brings a deleted entry back;
//   - PHOTO_KEY_PREFIX + address (photo storage - the IndexedDB-backed chat storage): the assigned
//     photo as a JPEG data URL (at most 384 px, quality 0.8). Your data, not cache: it stays until
//     you remove it, and it goes with its entry.
//
// Backup (NEXTCLOUD_SYNC.md §5): the archive carries optional `addressBook` (entries with ISO 8601
// whole-second dates and `photo` as raw base64 JPEG) and `addressBookDeleted`. Per address the
// newest edit or deletion wins; a tombstone at or after the entry's last edit deletes it.

export const ADDRESS_BOOK_ENTRIES_KEY = "kachat-address-book-v1";
export const ADDRESS_BOOK_DELETED_KEY = "kachat-address-book-deleted-v1";
export const ADDRESS_BOOK_PHOTO_KEY_PREFIX = "kachat-address-book-photo-v1:";
export const ADDRESS_BOOK_PHOTO_MAX_SIDE = 384;
export const ADDRESS_BOOK_PHOTO_QUALITY = 0.8;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let config = {
  storage: null,          // localStorage-like: getItem / setItem / removeItem / length / key(i)
  photoStorage: null,     // { get(key), set(key, value), remove(key) }
  scopedKey: (base, wallet) => `${wallet}:${base}`,
  wallet: () => "",
  isValidAddress: () => true,
  now: () => Date.now(),
};

/** { wallet, entries: Map<address, entry>, deleted: Map<address, ms>, sorted: entry[] | null } */
let cache = null;
const listeners = new Set();

export function configureAddressBook(options = {}) {
  config = { ...config, ...options };
  cache = null;
}

/** Called after every change (an edit here, a restore, a photo removal). */
export function onAddressBookChange(listener) {
  if (typeof listener === "function") listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(kind) {
  for (const listener of listeners) {
    try { listener(kind); } catch { /* a listener never breaks the store */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Kaspa addresses are lowercase; a pasted or scanned one may carry spaces or a `?amount=` query. */
export function normalizeAddressBookAddress(address) {
  let a = String(address ?? "").trim().toLowerCase();
  const q = a.indexOf("?");
  if (q >= 0) a = a.slice(0, q);
  return a;
}

function newUuid() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); } catch { /* fall through */ }
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[Math.floor(Math.random() * 4)];
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Whole-second ISO 8601: Swift's .iso8601 decoding rejects fractional seconds. */
export function addressBookIso(ms) {
  const value = Number(ms);
  const date = new Date(Number.isFinite(value) && value > 0 ? value : config.now());
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** ISO 8601 (with or without fractional seconds) or a number, to ms; 0 when unreadable. */
function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareEntries(a, b) {
  const order = String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
  if (order !== 0) return order;
  return a.address < b.address ? -1 : (a.address > b.address ? 1 : 0);
}

function readJson(key) {
  try {
    const raw = config.storage?.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const address = normalizeAddressBookAddress(raw.address);
  const name = String(raw.name ?? "").trim();
  if (!address || !name) return null;
  const createdAt = parseTime(raw.createdAt) || parseTime(raw.updatedAt) || config.now();
  return {
    id: UUID_PATTERN.test(String(raw.id || "")) ? String(raw.id).toLowerCase() : newUuid(),
    address,
    name,
    note: String(raw.note ?? "").trim(),
    createdAt,
    updatedAt: parseTime(raw.updatedAt) || createdAt,
  };
}

function currentWallet() {
  try { return String(config.wallet?.() || "").trim(); } catch { return ""; }
}

function entriesKey(wallet) { return config.scopedKey(ADDRESS_BOOK_ENTRIES_KEY, wallet); }
function deletedKey(wallet) { return config.scopedKey(ADDRESS_BOOK_DELETED_KEY, wallet); }
function photoKey(wallet, address) { return config.scopedKey(`${ADDRESS_BOOK_PHOTO_KEY_PREFIX}${normalizeAddressBookAddress(address)}`, wallet); }

function readWallet(wallet) {
  const entries = new Map();
  const deleted = new Map();
  if (!wallet) return { entries, deleted };
  const storedEntries = readJson(entriesKey(wallet));
  for (const raw of Array.isArray(storedEntries) ? storedEntries : []) {
    const entry = cleanEntry(raw);
    if (entry && !entries.has(entry.address)) entries.set(entry.address, entry);
  }
  const storedDeleted = readJson(deletedKey(wallet));
  for (const raw of Array.isArray(storedDeleted) ? storedDeleted : []) {
    const address = normalizeAddressBookAddress(raw?.address);
    const at = parseTime(raw?.deletedAt);
    if (!address || !at) continue;
    deleted.set(address, Math.max(deleted.get(address) || 0, at));
  }
  return { entries, deleted };
}

function load() {
  const wallet = currentWallet();
  if (cache && cache.wallet === wallet) return cache;
  const { entries, deleted } = readWallet(wallet);
  cache = { wallet, entries, deleted, sorted: null };
  return cache;
}

function writeWallet(wallet, entries, deleted) {
  if (!wallet || !config.storage) return;
  const list = [...entries.values()].sort(compareEntries);
  const tombs = [...deleted.entries()].map(([address, deletedAt]) => ({ address, deletedAt }))
    .sort((a, b) => (a.address < b.address ? -1 : 1));
  if (list.length) config.storage.setItem(entriesKey(wallet), JSON.stringify(list));
  else config.storage.removeItem(entriesKey(wallet));
  if (tombs.length) config.storage.setItem(deletedKey(wallet), JSON.stringify(tombs));
  else config.storage.removeItem(deletedKey(wallet));
}

function persist() {
  const c = load();
  c.sorted = null;
  writeWallet(c.wallet, c.entries, c.deleted);
}

function readPhoto(wallet, address) {
  if (!wallet || !config.photoStorage) return null;
  try {
    const value = config.photoStorage.get(photoKey(wallet, address));
    return typeof value === "string" && value ? value : null;
  } catch { return null; }
}

function writePhoto(wallet, address, dataUrl) {
  if (!wallet || !config.photoStorage) return;
  config.photoStorage.set(photoKey(wallet, address), dataUrl);
}

function deletePhoto(wallet, address) {
  if (!wallet || !config.photoStorage) return;
  try { config.photoStorage.remove(photoKey(wallet, address)); } catch { /* not stored */ }
}

/** Raw base64 JPEG (the archive's form) to a data URL; null when it isn't base64. */
export function addressBookPhotoFromBase64(base64) {
  const s = String(base64 ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  if (s.startsWith("data:image/")) return s;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  return `data:image/jpeg;base64,${s}`;
}

/** A data URL to the raw base64 the archive carries. */
export function addressBookPhotoToBase64(dataUrl) {
  const s = String(dataUrl ?? "");
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma >= 0 ? s.slice(comma + 1) : s;
}

/** Decoded size of a stored photo, in bytes. */
function photoBytes(dataUrl) {
  const base64 = addressBookPhotoToBase64(dataUrl);
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : (base64.endsWith("=") ? 1 : 0);
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Every entry of this wallet's book, sorted by name. */
export function addressBookEntries() {
  const c = load();
  if (!c.sorted) c.sorted = [...c.entries.values()].sort(compareEntries);
  return c.sorted.map((entry) => ({ ...entry }));
}

export function addressBookEntry(address) {
  const key = normalizeAddressBookAddress(address);
  if (!key) return null;
  const entry = load().entries.get(key);
  return entry ? { ...entry } : null;
}

/** The saved name for an address, or null - cheap, for display names. */
export function addressBookName(address) {
  const key = normalizeAddressBookAddress(address);
  if (!key) return null;
  return load().entries.get(key)?.name || null;
}

export function addressBookIsEmpty() {
  return load().entries.size === 0;
}

/** Entries whose name, address or note contains the query (case-insensitive). */
export function searchAddressBook(query) {
  const q = String(query ?? "").trim().toLowerCase();
  const all = addressBookEntries();
  if (!q) return all;
  return all.filter((e) => e.name.toLowerCase().includes(q) || e.address.includes(q) || e.note.toLowerCase().includes(q));
}

/** The photo you assigned to an address (a data URL), if any. */
export function addressBookPhoto(address) {
  return readPhoto(load().wallet, address);
}

export function hasAddressBookPhoto(address) {
  return Boolean(addressBookPhoto(address));
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/**
 * Adds `address`, or updates its entry when it is already saved. `photo`: undefined keeps the
 * saved photo, a data URL sets it, null removes it. Throws an Error whose message is the text
 * to show ("Open a wallet first." / "Enter a name." / "Enter a valid Kaspa address.").
 */
export function saveAddressBookEntry({ address, name, note = "", photo } = {}) {
  const c = load();
  if (!c.wallet) throw new Error("Open a wallet first.");
  const key = normalizeAddressBookAddress(address);
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("Enter a name.");
  let valid = false;
  try { valid = Boolean(key) && config.isValidAddress(key) !== false; } catch { valid = false; }
  if (!valid) throw new Error("Enter a valid Kaspa address.");
  // The photo goes first: a full store refuses it before anything else changes.
  if (typeof photo === "string" && photo) {
    try { writePhoto(c.wallet, key, photo); } catch { throw new Error("Couldn't use that photo."); }
  } else if (photo === null) {
    deletePhoto(c.wallet, key);
  }
  const now = config.now();
  const existing = c.entries.get(key);
  const saved = existing
    ? { ...existing, name: cleanName, note: String(note ?? "").trim(), updatedAt: now }
    : { id: newUuid(), address: key, name: cleanName, note: String(note ?? "").trim(), createdAt: now, updatedAt: now };
  c.entries.set(key, saved);
  c.deleted.delete(key);
  persist();
  emit("edit");
  return { ...saved };
}

/** Deletes an entry (and its photo), leaving a tombstone for the backup merge. */
export function removeAddressBookEntry(address) {
  const c = load();
  const key = normalizeAddressBookAddress(address);
  if (!c.wallet || !c.entries.has(key)) return false;
  c.entries.delete(key);
  c.deleted.set(key, config.now());
  deletePhoto(c.wallet, key);
  persist();
  emit("edit");
  return true;
}

// ---------------------------------------------------------------------------------------------
// Photos on this device (Settings > Storage)
// ---------------------------------------------------------------------------------------------

/** Every wallet on this device that has a stored book. */
function walletsWithBooks() {
  const storage = config.storage;
  if (!storage) return [];
  const marker = "\u0001W\u0001";
  const probe = config.scopedKey(ADDRESS_BOOK_ENTRIES_KEY, marker);
  const at = probe.indexOf(marker);
  if (at < 0) return [];
  const prefix = probe.slice(0, at);
  const suffix = probe.slice(at + marker.length);
  const wallets = new Set();
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
      const wallet = key.slice(prefix.length, key.length - suffix.length);
      if (wallet) wallets.add(wallet);
    }
  } catch { /* storage unreadable */ }
  const current = currentWallet();
  if (current && load().entries.size) wallets.add(current);
  return [...wallets];
}

/** Space the assigned photos of every wallet on this device take, in bytes. */
export function addressBookPhotoBytes() {
  let total = 0;
  for (const wallet of walletsWithBooks()) {
    const { entries } = wallet === currentWallet() ? load() : readWallet(wallet);
    for (const address of entries.keys()) total += photoBytes(readPhoto(wallet, address));
  }
  return total;
}

/**
 * Deletes the assigned photos of every wallet on this device. Each affected entry counts as
 * edited, so the removal reaches the backup instead of the photo coming back from it.
 */
export function removeAllAddressBookPhotos() {
  const now = config.now();
  let removed = 0;
  const current = currentWallet();
  for (const wallet of walletsWithBooks()) {
    const isCurrent = wallet === current;
    const book = isCurrent ? load() : readWallet(wallet);
    let changed = false;
    for (const [address, entry] of book.entries) {
      if (!readPhoto(wallet, address)) continue;
      deletePhoto(wallet, address);
      book.entries.set(address, { ...entry, updatedAt: now });
      changed = true;
      removed += 1;
    }
    if (!changed) continue;
    if (isCurrent) persist();
    else writeWallet(wallet, book.entries, book.deleted);
  }
  if (removed) emit("photos");
  return removed;
}

/** Account removal: that wallet's entries, tombstones and photos all go. */
export function removeAddressBookForWallet(wallet) {
  const clean = String(wallet || "").trim();
  if (!clean) return;
  const { entries } = readWallet(clean);
  for (const address of entries.keys()) deletePhoto(clean, address);
  try { config.storage?.removeItem(entriesKey(clean)); } catch { /* not stored */ }
  try { config.storage?.removeItem(deletedKey(clean)); } catch { /* not stored */ }
  if (cache && cache.wallet === clean) cache = null;
}

// ---------------------------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------------------------

/** An entry in the archive's shape (iOS AddressBookEntry, JSONEncoder .iso8601). */
function toArchiveEntry(entry, photoDataUrl) {
  const out = {
    id: entry.id,
    address: entry.address,
    name: entry.name,
    note: entry.note || "",
    createdAt: addressBookIso(entry.createdAt),
    updatedAt: addressBookIso(entry.updatedAt),
  };
  const base64 = photoDataUrl ? addressBookPhotoToBase64(photoDataUrl) : "";
  if (base64) out.photo = base64;
  return out;
}

/** What the backup carries for this wallet: `{ addressBook, addressBookDeleted }`, each entry
 *  with its assigned photo attached. Both empty when the wallet has no book. */
export function archiveAddressBook() {
  const c = load();
  const addressBook = addressBookEntries().map((entry) => toArchiveEntry(entry, readPhoto(c.wallet, entry.address)));
  const addressBookDeleted = [...c.deleted.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([address, deletedAt]) => ({ address, deletedAt: addressBookIso(deletedAt) }));
  return { addressBook, addressBookDeleted };
}

/**
 * The merge both a restore and the shared-file upload use (iOS AddressBookManager.merge): per
 * address the newest `updatedAt` wins (the earlier side on a tie), unless a tombstone's
 * `deletedAt` is at or after it - then only the tombstone is kept. Entries and tombstones may
 * carry ISO strings or ms; the winners come back as they were given (their `photo` included).
 */
export function mergeAddressBooks(entrySides = [], tombstoneSides = []) {
  const latest = new Map();
  for (const side of entrySides) {
    for (const raw of Array.isArray(side) ? side : []) {
      if (!raw || typeof raw !== "object") continue;
      const address = normalizeAddressBookAddress(raw.address);
      if (!address || !String(raw.name ?? "").trim()) continue;
      const at = parseTime(raw.updatedAt);
      const have = latest.get(address);
      if (have && have.at >= at) continue;
      latest.set(address, { at, entry: { ...raw, address } });
    }
  }
  const deletedAt = new Map();
  for (const side of tombstoneSides) {
    for (const raw of Array.isArray(side) ? side : []) {
      const address = normalizeAddressBookAddress(raw?.address);
      if (!address) continue;
      const at = parseTime(raw?.deletedAt);
      deletedAt.set(address, Math.max(deletedAt.get(address) ?? -Infinity, at));
    }
  }
  const entries = [];
  for (const [address, { at, entry }] of latest) {
    const d = deletedAt.get(address);
    if (d !== undefined && d >= at) continue;
    entries.push(entry);
    deletedAt.delete(address);
  }
  entries.sort((a, b) => compareEntries({ name: String(a.name ?? ""), address: a.address }, { name: String(b.name ?? ""), address: b.address }));
  const tombstones = [...deletedAt.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([address, at]) => ({ address, deletedAt: at }));
  return { entries, tombstones };
}

/** The shared file's two sides merged, in the archive's own shape (ISO dates, raw base64 photo).
 *  Local first, as iOS does, so a tie keeps this device's copy. */
export function mergeAddressBookArchives(local, remote) {
  const merged = mergeAddressBooks(
    [local?.addressBook, remote?.addressBook],
    [local?.addressBookDeleted, remote?.addressBookDeleted],
  );
  const addressBook = merged.entries.map((raw) => {
    const entry = cleanEntry(raw);
    if (!entry) return null;
    const out = toArchiveEntry(entry, null);
    const photo = String(raw.photo ?? "").trim();
    if (photo) out.photo = addressBookPhotoToBase64(photo);
    return out;
  }).filter(Boolean);
  const addressBookDeleted = merged.tombstones.map((t) => ({ address: t.address, deletedAt: addressBookIso(t.deletedAt) }));
  return { addressBook, addressBookDeleted };
}

/**
 * A restore into this wallet's book: per address the newest event wins - an entry edited after
 * it was deleted elsewhere comes back, one deleted after its last edit stays deleted. The winning
 * entry decides the photo: one that came with a photo writes it; an incoming winner without one
 * removes ours (it was removed where that edit was made). Returns true when anything was applied.
 */
export function importAddressBookArchive(incomingEntries, incomingTombstones) {
  const c = load();
  const entriesIn = Array.isArray(incomingEntries) ? incomingEntries : [];
  const tombsIn = Array.isArray(incomingTombstones) ? incomingTombstones : [];
  if (!c.wallet || (!entriesIn.length && !tombsIn.length)) return false;
  const before = new Map(c.entries);
  const localTombs = [...c.deleted.entries()].map(([address, deletedAt]) => ({ address, deletedAt }));
  const merged = mergeAddressBooks([[...c.entries.values()], entriesIn], [localTombs, tombsIn]);
  const entries = new Map();
  for (const raw of merged.entries) {
    const entry = cleanEntry(raw);
    if (!entry) continue;
    const local = before.get(entry.address);
    const photo = addressBookPhotoFromBase64(raw.photo);
    if (photo) {
      try { writePhoto(c.wallet, entry.address, photo); } catch { /* storage full: keeps the entry */ }
    } else if (!local || local.updatedAt < entry.updatedAt) {
      deletePhoto(c.wallet, entry.address);
    }
    // A local winner keeps its own id and times; an incoming one brings its own.
    entries.set(entry.address, local && local.updatedAt >= entry.updatedAt ? local : entry);
  }
  for (const t of merged.tombstones) deletePhoto(c.wallet, t.address);
  c.entries = entries;
  c.deleted = new Map(merged.tombstones.map((t) => [t.address, t.deletedAt]));
  persist();
  emit("restore");
  return true;
}
