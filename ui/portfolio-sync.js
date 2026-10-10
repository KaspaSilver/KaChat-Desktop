// Portfolios in Nextcloud Automatic Sync (NEXTCLOUD_SYNC.md §5 "Portfolios", iOS 11f1548
// PortfolioSync / PortfolioLedgerStore.stamped). No DOM and no imports, so
// tools/test-portfolio-sync.mjs runs it under node; ui/portfolio.js owns the storage.
//
// The archive carries four optional top-level keys (older archives omit them):
//   - portfolios             [{ id, name, sortOrder, createdAt, updatedAt? }]
//   - portfolioTransactions  [{ id, type, amountSompi, fiatValue, timestamp, notes?, portfolioId,
//                               sourceAddress?, sourceTxId?, updatedAt? }]
//   - portfolioFees          [{ txId, portfolioId, sourceAddress, amountSompi, timestamp, fiatValue? }]
//   - portfolioDeleted       [{ kind: "portfolio" | "transaction", id, deletedAt }]
// Dates are whole-second ISO 8601 (Swift's .iso8601 rejects fractions); portfolio ids are UUIDs,
// written uppercase as iOS's uuidString is, because iOS matches portfolio tombstones by that string.
//
// In here a "sync" is { portfolios, transactions, fees, tombstones } in the archive's field names
// with every date in ms; toArchive / fromArchive convert at the file's edge, fromDesktop / toDesktop
// at the store's (Desktop keeps rows inside their portfolio, in KAS, and orders by array position).

export const PORTFOLIO_SEED_NAME = "Portfolio 1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_TYPES = new Set(["buy", "sell", "transfer"]);

export function isPortfolioUuid(value) {
  return UUID_RE.test(String(value ?? "").trim());
}

/** A new id, uppercase like iOS's `UUID().uuidString`. */
export function newPortfolioUuid() {
  try { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().toUpperCase(); } catch { /* fall through */ }
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = "89ab"[Math.floor(Math.random() * 4)];
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`.toUpperCase();
}

/** A portfolio id as it is compared and written: an uppercase UUID, or "" when it isn't one. */
function portfolioIdOf(value) {
  const raw = String(value ?? "").trim();
  return UUID_RE.test(raw) ? raw.toUpperCase() : "";
}

/** Whole-second ISO 8601. */
export function portfolioSyncIso(ms) {
  const date = new Date(Number(ms));
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** An archive or stored date to ms: ISO 8601 (with or without fractions), ms or seconds since
 *  1970, or Swift's seconds since 2001 (a date encoded without the iso strategy). NaN when none. */
function timeOf(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return NaN;
    if (value >= 1e12) return value;
    if (value >= 1e9) return value * 1000;
    return (value + 978307200) * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function optionalTime(value) {
  const ms = timeOf(value);
  return Number.isFinite(ms) ? ms : null;
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text : null;
}

// ---------------------------------------------------------------------------------------------
// One item, cleaned into the sync shape (null when it can't be read)
// ---------------------------------------------------------------------------------------------

function cleanPortfolio(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = portfolioIdOf(raw.id);
  const createdAt = timeOf(raw.createdAt);
  if (!id || !Number.isFinite(createdAt)) return null;
  return {
    id,
    name: String(raw.name ?? ""),
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Math.trunc(Number(raw.sortOrder)) : 0,
    createdAt,
    updatedAt: optionalTime(raw.updatedAt),
  };
}

function cleanTransaction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const portfolioId = portfolioIdOf(raw.portfolioId);
  const type = String(raw.type ?? "");
  const timestamp = timeOf(raw.timestamp);
  const amountSompi = Number(raw.amountSompi);
  if (!id || !portfolioId || !TX_TYPES.has(type) || !Number.isFinite(timestamp) || !Number.isFinite(amountSompi)) return null;
  const fiatValue = Number(raw.fiatValue);
  return {
    id,
    type,
    amountSompi: Math.round(amountSompi),
    fiatValue: Number.isFinite(fiatValue) ? fiatValue : 0,
    timestamp,
    notes: optionalText(raw.notes),
    portfolioId,
    sourceAddress: optionalText(raw.sourceAddress),
    sourceTxId: optionalText(raw.sourceTxId),
    updatedAt: optionalTime(raw.updatedAt),
  };
}

function cleanFee(raw) {
  if (!raw || typeof raw !== "object") return null;
  const txId = String(raw.txId ?? "").trim();
  const portfolioId = portfolioIdOf(raw.portfolioId);
  const timestamp = timeOf(raw.timestamp);
  const amountSompi = Number(raw.amountSompi);
  if (!txId || !portfolioId || !Number.isFinite(timestamp) || !Number.isFinite(amountSompi)) return null;
  const fiatValue = raw.fiatValue === null || raw.fiatValue === undefined ? NaN : Number(raw.fiatValue);
  return {
    txId,
    portfolioId,
    sourceAddress: String(raw.sourceAddress ?? ""),
    amountSompi: Math.round(amountSompi),
    timestamp,
    fiatValue: Number.isFinite(fiatValue) ? fiatValue : null,
  };
}

function cleanTombstone(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = String(raw.kind ?? "");
  if (kind !== "portfolio" && kind !== "transaction") return null;
  const id = kind === "portfolio" ? portfolioIdOf(raw.id) : String(raw.id ?? "").trim();
  const deletedAt = timeOf(raw.deletedAt);
  if (!id || !Number.isFinite(deletedAt)) return null;
  return { kind, id, deletedAt };
}

function cleanList(list, clean) {
  return (Array.isArray(list) ? list : []).map(clean).filter(Boolean);
}

/** The fee's identity (iOS PortfolioFeeRecord.id): one fee per transaction per portfolio. */
export function portfolioFeeKey(fee) {
  return `${fee.portfolioId}:${fee.txId}`;
}

// ---------------------------------------------------------------------------------------------
// Archive edge
// ---------------------------------------------------------------------------------------------

/** The archive's four keys (a whole archive object is fine) as a sync. Unreadable items are
 *  skipped one by one. */
export function portfolioSyncFromArchive(archive) {
  return {
    portfolios: cleanList(archive?.portfolios, cleanPortfolio),
    transactions: cleanList(archive?.portfolioTransactions, cleanTransaction),
    fees: cleanList(archive?.portfolioFees, cleanFee),
    tombstones: cleanList(archive?.portfolioDeleted, cleanTombstone),
  };
}

/** A sync as the archive's four keys, each left out when empty (iOS writes nil then). Optional
 *  fields are left out when unset, as Swift's encoder does. */
export function portfolioSyncToArchive(sync) {
  const portfolios = sync.portfolios.map((p) => ({
    id: p.id,
    name: p.name,
    sortOrder: p.sortOrder,
    createdAt: portfolioSyncIso(p.createdAt),
    ...(p.updatedAt !== null ? { updatedAt: portfolioSyncIso(p.updatedAt) } : {}),
  }));
  const portfolioTransactions = sync.transactions.map((t) => ({
    id: t.id,
    type: t.type,
    amountSompi: t.amountSompi,
    fiatValue: t.fiatValue,
    timestamp: portfolioSyncIso(t.timestamp),
    ...(t.notes !== null ? { notes: t.notes } : {}),
    portfolioId: t.portfolioId,
    ...(t.sourceAddress !== null ? { sourceAddress: t.sourceAddress } : {}),
    ...(t.sourceTxId !== null ? { sourceTxId: t.sourceTxId } : {}),
    ...(t.updatedAt !== null ? { updatedAt: portfolioSyncIso(t.updatedAt) } : {}),
  }));
  const portfolioFees = sync.fees.map((f) => ({
    txId: f.txId,
    portfolioId: f.portfolioId,
    sourceAddress: f.sourceAddress,
    amountSompi: f.amountSompi,
    timestamp: portfolioSyncIso(f.timestamp),
    ...(f.fiatValue !== null ? { fiatValue: f.fiatValue } : {}),
  }));
  const portfolioDeleted = sync.tombstones.map((t) => ({ kind: t.kind, id: t.id, deletedAt: portfolioSyncIso(t.deletedAt) }));
  return {
    ...(portfolios.length ? { portfolios } : {}),
    ...(portfolioTransactions.length ? { portfolioTransactions } : {}),
    ...(portfolioFees.length ? { portfolioFees } : {}),
    ...(portfolioDeleted.length ? { portfolioDeleted } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Desktop store edge: [{ id, name, createdAt, updatedAt?, transactions: [{ id, type, amountKas,
// fiatValue, timestamp, notes, sourceAddress?, sourceTxId?, updatedAt? }] }], ms dates, array order
// ---------------------------------------------------------------------------------------------

export function portfolioSyncFromDesktop(portfolios = [], fees = [], tombstones = []) {
  const list = Array.isArray(portfolios) ? portfolios : [];
  const synced = [];
  const transactions = [];
  list.forEach((p, index) => {
    const portfolio = cleanPortfolio({ ...p, sortOrder: index });
    if (!portfolio) return;
    synced.push(portfolio);
    for (const tx of Array.isArray(p.transactions) ? p.transactions : []) {
      const row = cleanTransaction({ ...tx, amountSompi: Math.round((Number(tx?.amountKas) || 0) * 1e8), portfolioId: portfolio.id });
      if (row) transactions.push(row);
    }
  });
  return {
    portfolios: synced,
    transactions,
    fees: cleanList(fees, cleanFee),
    tombstones: cleanList(tombstones, cleanTombstone),
  };
}

/** A sync back in the store's shape: `{ portfolios, fees, tombstones }`, rows inside their
 *  portfolio in the sync's order, fees as their records, every date in ms. */
export function portfolioSyncToDesktop(sync) {
  const rowsByPortfolio = new Map();
  for (const t of sync.transactions) {
    if (!rowsByPortfolio.has(t.portfolioId)) rowsByPortfolio.set(t.portfolioId, []);
    rowsByPortfolio.get(t.portfolioId).push({
      id: t.id,
      type: t.type,
      amountKas: t.amountSompi / 1e8,
      fiatValue: t.fiatValue,
      timestamp: t.timestamp,
      notes: t.notes,
      sourceAddress: t.sourceAddress,
      sourceTxId: t.sourceTxId,
      ...(t.updatedAt !== null ? { updatedAt: t.updatedAt } : {}),
    });
  }
  return {
    portfolios: sync.portfolios.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      ...(p.updatedAt !== null ? { updatedAt: p.updatedAt } : {}),
      transactions: rowsByPortfolio.get(p.id) || [],
    })),
    fees: sync.fees.map((f) => ({ ...f })),
    tombstones: sync.tombstones.map((t) => ({ ...t })),
  };
}

// ---------------------------------------------------------------------------------------------
// Rules (iOS PortfolioSync)
// ---------------------------------------------------------------------------------------------

/** A wallet's untouched seed: "Portfolio 1", never edited, holding nothing. Every install makes
 *  its own (each with its own id), so seeds never sync. */
export function isPristinePortfolioSeed(p, transactions = [], fees = []) {
  return (p.updatedAt === null || p.updatedAt === undefined) && p.name === PORTFOLIO_SEED_NAME
    && !transactions.some((t) => t.portfolioId === p.id) && !fees.some((f) => f.portfolioId === p.id);
}

/** What this device uploads: everything but a pristine seed. */
export function portfolioSyncForArchive(sync) {
  return { ...sync, portfolios: sync.portfolios.filter((p) => !isPristinePortfolioSeed(p, sync.transactions, sync.fees)) };
}

export function isPortfolioSyncEmpty(sync) {
  return !sync.portfolios.length && !sync.transactions.length && !sync.fees.length && !sync.tombstones.length;
}

function compareStrings(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

/** Every side's tombstones, the newest per item. */
export function mergePortfolioTombstones(sides) {
  const newest = new Map();
  for (const side of sides) {
    for (const t of side || []) {
      const key = `${t.kind}:${t.id}`;
      const have = newest.get(key);
      if (have && have.deletedAt >= t.deletedAt) continue;
      newest.set(key, t);
    }
  }
  return [...newest.values()].sort((a, b) => compareStrings(a.kind, b.kind) || compareStrings(a.id, b.id));
}

/**
 * Folds what two devices each made on their own before sync existed (iOS 54788da
 * PortfolioSync.foldEquivalents, IOS-073): portfolios with the same name and no `updatedAt`
 * become one (the oldest stays; a createdAt tie keeps the smaller id, so either order folds the
 * same way), their rows and fees move with them, and a row whose (portfolio, sourceTxId) is
 * already there - the same imported transaction - is kept once (the newest edit, ties by the
 * smaller id: the same choice on every device, so the copies don't trade places).
 */
export function foldPortfolioEquivalents(sides) {
  const keep = new Map();
  for (const p of sides.flatMap((s) => s.portfolios)) {
    if (p.updatedAt !== null && p.updatedAt !== undefined) continue;
    const have = keep.get(p.name);
    if (have && (have.createdAt < p.createdAt || (have.createdAt === p.createdAt && compareStrings(have.id, p.id) <= 0))) continue;
    keep.set(p.name, p);
  }
  const remap = new Map();
  for (const p of sides.flatMap((s) => s.portfolios)) {
    if (p.updatedAt !== null && p.updatedAt !== undefined) continue;
    const canonical = keep.get(p.name);
    if (canonical && canonical.id !== p.id) remap.set(p.id, canonical.id);
  }
  const target = (id) => remap.get(id) ?? id;
  const winner = new Map();
  for (const t of sides.flatMap((s) => s.transactions)) {
    if (!t.sourceTxId) continue;
    const key = `${target(t.portfolioId)}:${t.sourceTxId}`;
    const have = winner.get(key);
    const a = have ? (have.updatedAt ?? -Infinity) : 0;
    const b = t.updatedAt ?? -Infinity;
    if (!have || b > a || (b === a && compareStrings(t.id, have.id) < 0)) winner.set(key, t);
  }
  return sides.map((side) => ({
    ...side,
    portfolios: side.portfolios.filter((p) => !remap.has(p.id)),
    transactions: side.transactions.flatMap((t) => {
      const moved = remap.has(t.portfolioId) ? { ...t, portfolioId: target(t.portfolioId) } : t;
      if (!moved.sourceTxId) return [moved];
      return winner.get(`${moved.portfolioId}:${moved.sourceTxId}`) === t ? [moved] : [];
    }),
    fees: side.fees.map((f) => (remap.has(f.portfolioId) ? { ...f, portfolioId: target(f.portfolioId) } : f)),
  }));
}

/**
 * iOS PortfolioSync.merge: what two devices made before sync is folded first
 * (foldPortfolioEquivalents, iOS 54788da); then per item the newest `updatedAt` wins (a portfolio without one counts
 * as its createdAt, a row without one as the oldest possible; a tie keeps the earlier side),
 * unless a tombstone at or after it deletes it. A row or fee lives only while its portfolio does;
 * a priced fee beats an unpriced one. A pristine seed stays only while nothing else is there.
 * The list is ordered by sortOrder (ties by createdAt) and renumbered 0..n-1.
 */
export function mergePortfolioSync(sides) {
  sides = foldPortfolioEquivalents(sides);
  const tombstones = mergePortfolioTombstones(sides.map((s) => s.tombstones));
  const gone = new Map(tombstones.map((t) => [`${t.kind}:${t.id}`, t.deletedAt]));

  const portfolios = new Map();
  for (const p of sides.flatMap((s) => s.portfolios)) {
    const stamp = p.updatedAt ?? p.createdAt;
    const have = portfolios.get(p.id);
    if (have && (have.updatedAt ?? have.createdAt) >= stamp) continue;
    portfolios.set(p.id, p);
  }
  for (const [id, p] of portfolios) {
    const deletedAt = gone.get(`portfolio:${id}`);
    if (deletedAt !== undefined && deletedAt >= (p.updatedAt ?? p.createdAt)) portfolios.delete(id);
  }

  const transactions = new Map();
  for (const t of sides.flatMap((s) => s.transactions)) {
    const stamp = t.updatedAt ?? -Infinity;
    const have = transactions.get(t.id);
    if (have && (have.updatedAt ?? -Infinity) >= stamp) continue;
    transactions.set(t.id, t);
  }
  for (const [id, t] of transactions) {
    const deletedAt = gone.get(`transaction:${id}`);
    if (!portfolios.has(t.portfolioId) || (deletedAt !== undefined && deletedAt >= (t.updatedAt ?? -Infinity))) {
      transactions.delete(id);
    }
  }

  const fees = new Map();
  for (const f of sides.flatMap((s) => s.fees)) {
    if (!portfolios.has(f.portfolioId)) continue;
    const key = portfolioFeeKey(f);
    const have = fees.get(key);
    // A priced copy beats an unpriced one; otherwise either (they are the same fee).
    if (have && (have.fiatValue !== null || f.fiatValue === null)) continue;
    fees.set(key, f);
  }

  const txList = [...transactions.values()];
  const feeList = [...fees.values()];
  let list = [...portfolios.values()];
  if (list.some((p) => !isPristinePortfolioSeed(p, txList, feeList))) {
    list = list.filter((p) => !isPristinePortfolioSeed(p, txList, feeList));
  }
  list.sort((a, b) => (a.sortOrder === b.sortOrder ? a.createdAt - b.createdAt : a.sortOrder - b.sortOrder));
  return {
    portfolios: list.map((p, index) => ({ ...p, sortOrder: index })),
    transactions: txList.sort((a, b) => (a.timestamp === b.timestamp ? compareStrings(a.id, b.id) : a.timestamp - b.timestamp)),
    fees: feeList.sort((a, b) => compareStrings(portfolioFeeKey(a), portfolioFeeKey(b))),
    tombstones,
  };
}

/** The shared file's two sides' portfolio keys merged, in the archive's shape; the empty ones
 *  left out (iOS mergeArchivePortfolios). Local first, so a tie keeps this device's copy. */
export function mergePortfolioArchives(local, remote) {
  const merged = mergePortfolioSync([portfolioSyncFromArchive(local), portfolioSyncFromArchive(remote)]);
  return portfolioSyncToArchive(portfolioSyncForArchive(merged));
}

// ---------------------------------------------------------------------------------------------
// Stamping (iOS PortfolioLedgerStore.stamped), on the store's shape
// ---------------------------------------------------------------------------------------------

function portfolioFingerprint(p, index) {
  return JSON.stringify([String(p?.name ?? ""), Number(p?.createdAt) || 0, index]);
}

function rowFingerprint(t, portfolioId) {
  return JSON.stringify([
    String(t?.type ?? ""), Number(t?.amountKas) || 0, Number(t?.fiatValue) || 0, Number(t?.timestamp) || 0,
    t?.notes ?? null, t?.sourceAddress ?? null, t?.sourceTxId ?? null, portfolioId,
  ]);
}

/**
 * Compares the list as it is about to be saved with the list as last saved: every portfolio
 * added, renamed or moved and every row added, edited or moved to another portfolio gets
 * `updatedAt = now` (in place); anything gone comes back as a tombstone. A row that only moved
 * between portfolios is not a deletion.
 */
export function stampPortfolioChanges(previous, current, now) {
  const before = new Map();
  const rowsBefore = new Map();
  (previous || []).forEach((p, index) => {
    before.set(p.id, portfolioFingerprint(p, index));
    for (const t of p.transactions || []) rowsBefore.set(t.id, rowFingerprint(t, p.id));
  });
  let stamped = false;
  const ids = new Set();
  const rowIds = new Set();
  (current || []).forEach((p, index) => {
    ids.add(p.id);
    if (before.get(p.id) !== portfolioFingerprint(p, index)) { p.updatedAt = now; stamped = true; }
    for (const t of p.transactions || []) {
      rowIds.add(t.id);
      if (rowsBefore.get(t.id) !== rowFingerprint(t, p.id)) { t.updatedAt = now; stamped = true; }
    }
  });
  const tombstones = [
    ...[...before.keys()].filter((id) => !ids.has(id)).map((id) => ({ kind: "portfolio", id, deletedAt: now })),
    ...[...rowsBefore.keys()].filter((id) => !rowIds.has(id)).map((id) => ({ kind: "transaction", id, deletedAt: now })),
  ];
  return { changed: stamped || tombstones.length > 0, tombstones };
}
