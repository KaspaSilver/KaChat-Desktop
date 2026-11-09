// Group-chat state + orchestration (the "GroupBag/roster store" + service layer,
// mirroring iOS's GroupStore + GroupChatService). Persists per-wallet group state
// in localStorage, drives key distribution over the 1:1 ECIES channel, and turns
// on-chain payloads into decoded messages. Pure of DOM/UI; the app layer renders
// what syncGroups() returns and calls createGroup/sendGroupMessage/etc.
//
// The injected `engine` must provide: address, privateKeyHex, xOnlyPubKeyForAddress,
// sendGroupPayload, encryptGroupControl, decryptGroupControl, and the scanGroup*
// methods (see engine/index.js).
import * as G from "./group.js";
import { SEND_OUTCOME_UNKNOWN } from "./transactions.js";
import { SEND_ACCOUNT_CHANGED } from "./messages.js";
import { groupPayloadFromHex, proofWithRetries, PROOF_RETRY_DELAYS_MS } from "./outage-scan.js";

const GROUPS_KEY = "kachat-groups-v1";
// Per-wallet group deletion tombstones: { [wallet]: { deleted: [entry...], published: [entry...] } }.
// An entry is G.groupInviteKey (that admin's offer of the id), or a bare group id for that id from
// any admin, which is what a v1 marker means.
// `deleted` blocks a group from ever being re-added by discovery/recovery; `published` tracks
// which tombstones have been written on-chain (so the delete survives a seedless re-import).
const GROUP_TOMBSTONES_KEY = "kachat-group-tombstones-v1";
// Per-wallet cursor for the by-recipient control stream (DSK-041; iOS groupCatchUpCursors
// "gctl-recipient|<wallet>"): { [wallet]: { cursor, indexer, caughtUp, updatedAt } }. Its own
// key, bucketed by wallet exactly like the two above (a bucket of kachat-groups-v1 is a map of
// group id -> record, so it cannot hold anything else), and wiped with them on account removal.
// The wallet key is the running network's address (kaspa:/kaspatest:), which keeps the two
// networks apart; `indexer` is the indexer that issued the cursor - another one starts over.
export const GROUP_CONTROL_CURSOR_KEY = "kachat-group-control-cursor-v1";
// Pages of the by-recipient stream per sync pass (iOS: 40 x 50). A walk that spends it resumes
// from the stored cursor on the next pass - never from the start.
export const CONTROL_PAGE_LIMIT = 50;
export const CONTROL_PAGE_BUDGET = 40;
// Per-wallet high-water mark of the message counters this device has reserved (DSK-053):
// { [wallet]: { [groupId]: { "<deviceIdHex>:<epoch>": highestReservedCounter } } }. The message
// key and nonce derive only from (root, group, epoch, sender) and msg_id = device_id || counter,
// so a counter used twice in one epoch is ChaCha20-Poly1305 key+nonce reuse on chain. The
// record's msgCounter is the working value; this mark is kept apart from the record so that no
// write of a group record - stale or not - can move it backwards: it is only ever raised, and a
// reservation takes max(record.msgCounter, mark + 1). Keyed by device id and epoch because the
// counter legitimately starts again at 0 in a new epoch (new root = new key). Bucketed by wallet
// like the stores above; account removal must wipe it with them (handoff: ui/app.js list).
export const GROUP_MSG_COUNTER_KEY = "kachat-group-msg-counter-v1";
// Group invites (iOS bfe9f022, MESSAGING.md "Group invites"), per wallet. Being sent a root for a
// group this wallet doesn't hold is only an invite until it's answered:
// { [wallet]: [{ groupId, adminAddress, invitedAt, roots: [root payload, oldest first], rejected? }] }.
export const GROUP_INVITES_KEY = "kachat-group-invites-v1";
// What this wallet has answered and which of it is on chain:
// { [wallet]: { accepted: [invite key], published: [invite key], statusOutbox: [groupId] } }.
export const GROUP_INVITE_ANSWERS_KEY = "kachat-group-invite-answers-v1";
// Where members stand on their invite: { [wallet]: { [groupId]: { [address]: "invited" | "joined" |
// "declined" } } }. A member with no entry has no invite on record: groups from before invites.
export const GROUP_MEMBER_STATUS_KEY = "kachat-group-member-status-v1";
// Replay protection (iOS 4f8e14bb CDGroupSeenMessageId), per wallet, in oldest-first order:
// { [wallet]: { [groupId]: { [hash of sender, epoch, msg_id]: start of the claiming txid } } }.
// A gcomm's signature covers those and not the transaction, so anyone can put the same bytes in a
// new transaction, for a fresh block time and txid. Each id belongs to the first txid seen with it;
// the same txid read again (a rewind, a Refresh Messages) is still fine. Kept after a message is
// deleted or pruned, or the same bytes could bring it back. Hashed and truncated because this
// shares localStorage's quota with everything else. Bounded, oldest first: an id that has aged out
// can be replayed once more.
export const GROUP_SEEN_MSG_KEY = "kachat-group-seen-msgs-v1";
const SEEN_IDS_PER_GROUP = 5000;
const SEEN_IDS_PER_ACCOUNT = 20000;
const SEEN_KEY_BYTES = 12;
const SEEN_TX_TAG_LENGTH = 20;
// Kept in ui/app.js, which owns these two stores; only retention touches them from here.
const GROUP_REACTIONS_KEY = "kachat-group-reactions-v1";
const GROUP_EDITS_KEY = "kachat-group-edits-v1";
// Anyone can name you in a root for the price of a transaction, and each one is held until answered.
export const MAX_PENDING_GROUP_INVITES = 50;
export const MAX_PENDING_GROUP_INVITES_PER_ADMIN = 5;
// Who an admin took out of a group, on its record as `formerMembers` (iOS FormerGroupMember).
export const MAX_FORMER_MEMBERS_PER_GROUP = 64;
// Their lane is still read for this long after this device learned of the removal.
const FORMER_MEMBER_LANE_MS = 30 * 24 * 60 * 60 * 1000;
// Marks kept per group: older epochs are dropped. Only a stale write that rolled a record back
// by more than this many rotations could get past it, and the merge-on-write rule below already
// stops stale writes; this is the backstop, not the mechanism.
const COUNTER_MARKS_KEPT = 16;
// _commitRoot's answer on the quick path when the root does need its roster resolved.
const NEEDS_ROSTER = Symbol("needs-roster");

/** Block times arrive in seconds or milliseconds depending on the source; compared here in ms. */
function blockTimeMs(blockTime) {
  const time = Number(blockTime) || 0;
  return time > 1e12 ? time : time * 1000;
}

function seenIdKey(parsed) {
  const id = `${G.bytesToHex(parsed.senderId)}|${parsed.epoch}|${G.bytesToHex(parsed.msgId)}`;
  return G.bytesToHex(G.groupSha256(id).slice(0, SEEN_KEY_BYTES));
}

function dropOldestSeen(seen, count) {
  if (count <= 0) return;
  for (const key of Object.keys(seen).slice(0, count)) delete seen[key];
}

function trimSeenIds(byGroup, touched) {
  for (const groupId of touched) {
    const seen = byGroup[groupId];
    if (seen) dropOldestSeen(seen, Object.keys(seen).length - SEEN_IDS_PER_GROUP);
  }
  const sizeOf = (seen) => Object.keys(seen).length;
  let total = Object.values(byGroup).reduce((sum, seen) => sum + sizeOf(seen), 0);
  while (total > SEEN_IDS_PER_ACCOUNT) {
    const largest = Object.values(byGroup).reduce((a, b) => (sizeOf(b) > sizeOf(a) ? b : a));
    const drop = Math.min(total - SEEN_IDS_PER_ACCOUNT, Math.max(1, Math.ceil(sizeOf(largest) / 10)));
    dropOldestSeen(largest, drop);
    total -= drop;
  }
}

/** `held` plus whoever just left. A rejoiner's old entry stays until they're removed again (the
 *  roster check passes first). Someone whose key was never resolved can't be matched to a message. */
function withFormerMembers(held, removed, lastEpoch, removedAt) {
  const list = Array.isArray(held) ? held : [];
  const leaving = removed.filter((member) => member.xOnlyPubKeyHex);
  if (!leaving.length) return list;
  const now = Date.now();
  const addresses = new Set(leaving.map((member) => member.address));
  return [
    ...list.filter((entry) => !addresses.has(entry.address)),
    ...leaving.map((member) => ({
      address: member.address,
      xOnlyPubKeyHex: member.xOnlyPubKeyHex,
      isAdmin: false,
      lastEpoch,
      removedAt: blockTimeMs(removedAt) || now,
      recordedAt: now,
    })),
  ].slice(-MAX_FORMER_MEMBERS_PER_GROUP);
}

/** G.groupInviteKey of a held invite: its roots all come from one admin. */
function inviteKeyOf(invite) {
  return G.groupInviteKey(invite.groupId, invite.roots[invite.roots.length - 1].admin_signing_pub);
}

// Deep-ish clone via JSON is fine — records are plain data (hex strings, numbers).
function loadAll() {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveAll(all) {
  try { localStorage.setItem(GROUPS_KEY, JSON.stringify(all)); } catch {}
}
function loadTombstonesAll() {
  try { return JSON.parse(localStorage.getItem(GROUP_TOMBSTONES_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveTombstonesAll(all) {
  try { localStorage.setItem(GROUP_TOMBSTONES_KEY, JSON.stringify(all)); } catch {}
}
function loadJsonMap(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
  catch { return {}; }
}
function saveJsonMap(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch {}
}
function loadControlCursorsAll() {
  try { return JSON.parse(localStorage.getItem(GROUP_CONTROL_CURSOR_KEY) || "{}") || {}; }
  catch { return {}; }
}
function saveControlCursorsAll(all) {
  try { localStorage.setItem(GROUP_CONTROL_CURSOR_KEY, JSON.stringify(all)); } catch {}
}
function loadCounterMarksAll() {
  try { return JSON.parse(localStorage.getItem(GROUP_MSG_COUNTER_KEY) || "{}") || {}; }
  catch { return {}; }
}
// Returns whether the write landed: a reservation that could not be persisted must not be sent.
function saveCounterMarksAll(all) {
  try { localStorage.setItem(GROUP_MSG_COUNTER_KEY, JSON.stringify(all)); return true; }
  catch { return false; }
}

export class GroupManager {
  constructor(engine) {
    this.sinceSupported = null;   // null = not asked yet, false = indexer has no /since read
    this.sinceBlockTime = 0;
    this._sinceSeen = new Set();
    this._sincePasses = 0;
    this.engine = engine;
    this._selfPubHex = null;
    // DSK-053: group-store mutations are serialised on one promise chain (see _withGroupLock).
    this._lockTail = Promise.resolve();
    // The routine sync pass in flight (forceRefresh waits for it), how many forceRefresh calls
    // are running (the routine sync stands down meanwhile), and the chain that runs refreshes
    // one at a time (two would reset and re-walk the same control stream on top of each other).
    this._syncInFlight = null;
    this._refreshing = 0;
    this._refreshTail = Promise.resolve();
    // Bumped by rewindGroupCursors: a read in flight must not write its older position back.
    this._cursorRewinds = 0;
    this._sinceRewind = null;
    this._outageState = null;
    this._streamingFor = null;
    // The seen-id store while a synchronous batch has it open (_withSeenIds).
    this._seenOpen = null;
    // The Message retention cutoff last applied: { wallet, cutoffMs }.
    this._retentionFloor = null;
  }

  // --- replay protection (iOS GroupStore.claimMessageId) ---
  // One read and one write of the store per batch, however many rows it decodes. `fn` must be
  // synchronous, which is also what keeps another batch from opening it meanwhile.
  _withSeenIds(fn) {
    if (this._seenOpen) return fn(this._seenOpen);
    const open = { wallet: this.walletAddress, all: loadJsonMap(GROUP_SEEN_MSG_KEY), touched: new Set() };
    this._seenOpen = open;
    try { return fn(open); }
    finally {
      this._seenOpen = null;
      if (open.touched.size) {
        trimSeenIds(open.all[open.wallet], open.touched);
        saveJsonMap(GROUP_SEEN_MSG_KEY, open.all);
      }
    }
  }
  /** False when this id already belongs to another transaction: that's the replay. */
  _claimMessageId(groupId, parsed, txId) {
    const tag = String(txId || "").toLowerCase().slice(0, SEEN_TX_TAG_LENGTH);
    if (!tag) return true;
    return this._withSeenIds((open) => {
      const byGroup = open.all[open.wallet] && typeof open.all[open.wallet] === "object" ? open.all[open.wallet] : {};
      const seen = byGroup[groupId] && typeof byGroup[groupId] === "object" ? byGroup[groupId] : {};
      const key = seenIdKey(parsed);
      if (Object.prototype.hasOwnProperty.call(seen, key)) return seen[key] === tag;
      seen[key] = tag;
      byGroup[groupId] = seen;
      open.all[open.wallet] = byGroup;
      open.touched.add(groupId);
      return true;
    });
  }
  // A deleted group is tombstoned, as with its counter marks.
  _dropSeenIds(groupId) {
    const all = loadJsonMap(GROUP_SEEN_MSG_KEY);
    const byGroup = all[this.walletAddress];
    if (!byGroup || !Object.prototype.hasOwnProperty.call(byGroup, groupId)) return;
    delete byGroup[groupId];
    saveJsonMap(GROUP_SEEN_MSG_KEY, all);
  }

  // --- former members ---
  // Whether this block was made while they were in, for `epoch`. A block time at or after the
  // removal doesn't count: they keep the old epoch's key and could still sign with it.
  _formerMemberAt(record, senderPubHex, epoch, blockTime) {
    const at = blockTimeMs(blockTime);
    if (!at) return null;
    const former = (record.formerMembers || []).find((entry) => entry.xOnlyPubKeyHex === senderPubHex);
    return former && epoch <= former.lastEpoch && at < former.removedAt ? former : null;
  }
  /** Blinded ids to read: the roster, plus anyone lately gone from it (everyone ever, for a repair). */
  _laneIds(record, blindingKey, { allFormer = false } = {}) {
    const now = Date.now();
    const former = (record.formerMembers || []).filter((entry) => allFormer || now < entry.recordedAt + FORMER_MEMBER_LANE_MS);
    const pubs = [...record.members, ...former].map((member) => member.xOnlyPubKeyHex).filter(Boolean);
    return [...new Set(pubs)].map((pub) => G.bytesToHex(G.deriveBlindedGroupId(blindingKey, pub)));
  }

  // --- serialising writers (DSK-053) ---
  // Group sync, Refresh Messages, a send's counter reservation and control application all write
  // the same records. The rule that actually prevents lost updates: no write puts back a record
  // read before an await - every write re-reads the record and changes only the fields it owns,
  // all in one synchronous step (_mutate). This lock adds ordering on top: those steps run one at
  // a time, in call order. Rules that keep it deadlock-free:
  //  - a locked section never awaits another locked section (or anything that takes the lock);
  //  - locked sections are synchronous - network scans, sends, decryption and roster lookups all
  //    run OUTSIDE the lock, and only the read-merge-write step is locked;
  //  - a section that throws releases the lock (the tail swallows the error; the caller gets it).
  _withGroupLock(fn) {
    const run = this._lockTail.then(() => fn());
    this._lockTail = run.then(() => {}, () => {});
    return run;
  }
  // Re-read `groupId`, let `fn` change only the fields its caller owns, and write the fresh record.
  // Synchronous on purpose: nothing can interleave between the read and the write. `fn` returning
  // false skips the write. Returns the fresh record (null if the group is gone - e.g. deleted
  // while a scan ran - in which case nothing is written and nothing is resurrected).
  _mutate(groupId, fn) {
    const fresh = this.getGroup(groupId);
    if (!fresh) return null;
    if (fn(fresh) === false) return fresh;
    return this._put(fresh);
  }
  _mutateLocked(groupId, fn) {
    return this._withGroupLock(() => this._mutate(groupId, fn));
  }

  // --- monotonic message counter (DSK-053) ---
  _counterMark(groupId, deviceIdHex, epoch) {
    const mark = loadCounterMarksAll()[this.walletAddress]?.[groupId]?.[`${deviceIdHex}:${epoch}`];
    return Number.isSafeInteger(mark) && mark >= 0 ? mark : -1;
  }
  // Raise (never lower) the mark to `counter`. Returns false if it could not be persisted.
  _raiseCounterMark(groupId, deviceIdHex, epoch, counter) {
    const all = loadCounterMarksAll();
    const wallet = this.walletAddress;
    const byGroup = all[wallet] && typeof all[wallet] === "object" ? all[wallet] : {};
    const marks = byGroup[groupId] && typeof byGroup[groupId] === "object" ? byGroup[groupId] : {};
    const key = `${deviceIdHex}:${epoch}`;
    const held = Number.isSafeInteger(marks[key]) ? marks[key] : -1;
    if (held >= counter) return true;
    marks[key] = counter;
    const keys = Object.keys(marks);
    if (keys.length > COUNTER_MARKS_KEPT) {
      const epochOf = (k) => Number(k.slice(k.lastIndexOf(":") + 1)) || 0;
      for (const old of keys.filter((k) => k !== key).sort((a, b) => epochOf(a) - epochOf(b)).slice(0, keys.length - COUNTER_MARKS_KEPT)) delete marks[old];
    }
    byGroup[groupId] = marks;
    all[wallet] = byGroup;
    return saveCounterMarksAll(all);
  }
  // A deleted group is tombstoned and can never come back, so its marks can go with it.
  _dropCounterMarks(groupId) {
    const all = loadCounterMarksAll();
    const byGroup = all[this.walletAddress];
    if (!byGroup || !Object.prototype.hasOwnProperty.call(byGroup, groupId)) return;
    delete byGroup[groupId];
    saveCounterMarksAll(all);
  }
  // Locked by the caller. Reads the record fresh, takes max(record.msgCounter, mark + 1), raises
  // the mark FIRST (refusing to go on if it did not persist), then stores counter + 1 in the record.
  _reserveCounter(groupId) {
    const record = this.getGroup(groupId);
    if (!record) throw new Error("Group not found.");
    if (!record.groupRootEpochHex) throw new Error("No group key for the current epoch.");
    const deviceIdHex = String(record.deviceIdHex || "");
    const epoch = Number(record.currentEpoch || 0);
    const stored = Math.max(0, Math.floor(Number(record.msgCounter) || 0));
    const counter = Math.max(stored, this._counterMark(groupId, deviceIdHex, epoch) + 1);
    if (!this._raiseCounterMark(groupId, deviceIdHex, epoch, counter)) {
      throw new Error("Could not save the group message counter, so the message was not sent. Free up some storage and try again.");
    }
    record.msgCounter = counter + 1;
    this._put(record);
    return { record, counter };
  }

  get walletAddress() { return this.engine.address || ""; }

  // Our own x-only signing pubkey, derived once from the wallet key.
  selfPubHex() {
    if (!this._selfPubHex) this._selfPubHex = G.bytesToHex(G.xOnlyPublicKey(this.engine.privateKeyHex));
    return this._selfPubHex;
  }

  // --- persistence (scoped per wallet address) ---
  _bucket() {
    const all = loadAll();
    if (!all[this.walletAddress]) all[this.walletAddress] = {};
    return { all, bucket: all[this.walletAddress] };
  }
  listGroups() {
    const { bucket } = this._bucket();
    return Object.values(bucket).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  getGroup(groupId) {
    const { bucket } = this._bucket();
    return bucket[groupId] || null;
  }
  _put(record) {
    const { all, bucket } = this._bucket();
    record.updatedAt = record.updatedAt || 0;
    bucket[record.groupId] = record;
    all[this.walletAddress] = bucket;
    saveAll(all);
    return record;
  }
  /// Records a retired epoch's root without touching the current epoch.
  ///
  /// A non-admin has no other way back to pre-rotation messages: re-deriving an arbitrary epoch
  /// needs the group seed, which only the admin holds.
  _archivePreviousRoot(record, epoch, rootHex) {
    const root = String(rootHex || "");
    if (!root || !record) return;
    const key = String(epoch);
    // Written onto a fresh read of the record, never onto the caller's copy (DSK-053).
    this._mutate(record.groupId, (fresh) => {
      const roots = { ...(fresh.previousRootsHex || {}) };
      if (roots[key] === root) return false;
      roots[key] = root;
      fresh.previousRootsHex = roots;
      // A key we did not have a moment ago just arrived, and the message scan has already walked
      // past everything it could not read - the cursor advances on every row, decoded or not, so
      // ciphertext skipped for want of this key would never be asked for again. Dropping the
      // cursors makes the next sweep re-walk from the start and pick it all up. Re-reading is
      // cheap and idempotent: the app dedupes on msg_id and txid.
      fresh.cursors = {};
      return true;
    });
  }

  deleteGroup(groupId) {
    const admin = this.getGroup(groupId)?.adminSigningPub || null;
    const { all, bucket } = this._bucket();
    delete bucket[groupId];
    all[this.walletAddress] = bucket;
    saveAll(all);
    this._dropCounterMarks(String(groupId));
    this._dropSeenIds(String(groupId));
    // Tombstone it so discovery/recovery never re-adds it, and publish an on-chain delete
    // marker (best-effort now, retried by syncGroups' backfill) so the delete survives a
    // seedless re-import too. Local intent is recorded synchronously; the chain write is async.
    this._recordTombstone(groupId, admin, { published: false });
    Promise.resolve().then(() => this._publishTombstone(groupId, admin)).catch(() => {});
  }

  // --- deletion tombstones ---
  _tombstoneBucket() {
    const all = loadTombstonesAll();
    const bucket = all[this.walletAddress] || { deleted: [], published: [] };
    bucket.deleted = Array.isArray(bucket.deleted) ? bucket.deleted : [];
    bucket.published = Array.isArray(bucket.published) ? bucket.published : [];
    return { all, bucket };
  }
  /** With no admin to go on (an older backup), any marker for this id counts. */
  isGroupTombstoned(groupId, adminSigningPub = null) {
    const id = String(groupId);
    const { deleted } = this._tombstoneBucket().bucket;
    if (deleted.includes(id)) return true;
    if (!adminSigningPub) return deleted.some((entry) => entry.startsWith(`${id}:`));
    return deleted.includes(G.groupInviteKey(id, adminSigningPub));
  }
  _recordTombstone(groupId, adminSigningPub, { published }) {
    const id = String(groupId);
    const entry = adminSigningPub ? G.groupInviteKey(id, adminSigningPub) : id;
    const { all, bucket } = this._tombstoneBucket();
    if (!bucket.deleted.includes(entry)) bucket.deleted.push(entry);
    if (published && !bucket.published.includes(entry)) bucket.published.push(entry);
    all[this.walletAddress] = bucket;
    saveTombstonesAll(all);
    // A deleted group's invite goes with it, unless it's only waiting to say you declined.
    this._saveInvites(this._loadInvites().filter((invite) => invite.groupId !== id || invite.rejected === true
      || (adminSigningPub && inviteKeyOf(invite) !== entry)));
  }
  _markTombstonePublished(entry) {
    const { all, bucket } = this._tombstoneBucket();
    if (!bucket.published.includes(entry)) bucket.published.push(entry);
    all[this.walletAddress] = bucket;
    saveTombstonesAll(all);
  }
  // --- by-recipient control stream cursor (DSK-041) ---
  /** This wallet's stored by-recipient cursor state, or null (never walked / wiped / reset). */
  groupControlCursor(wallet = this.walletAddress) {
    const entry = loadControlCursorsAll()[wallet];
    return entry && typeof entry === "object" ? entry : null;
  }
  _saveGroupControlCursor(wallet, state) {
    if (!wallet) return;
    const all = loadControlCursorsAll();
    all[wallet] = { ...state, updatedAt: Date.now() };
    saveControlCursorsAll(all);
  }
  /** Forget this wallet's cursor, so the next pass walks the control stream from the start again
   *  (iOS refreshGroup drops "gctl-recipient|<wallet>" the same way). Idempotent to re-walk. */
  resetGroupControlCursor(wallet = this.walletAddress) {
    const all = loadControlCursorsAll();
    if (!Object.prototype.hasOwnProperty.call(all, wallet)) return;
    delete all[wallet];
    saveControlCursorsAll(all);
  }

  // Invites / rotations / photos / delete markers addressed to us, read from the persisted cursor
  // (iOS catchUpGroupControlByRecipient). Rules:
  //  - no cursor (fresh import, wiped, reset, other indexer): walk from the start of the stream;
  //  - a cursor: start after it, so steady state is one request that comes back empty;
  //  - the cursor is written AFTER a page's rows are applied, never before, so an interruption
  //    (error, reload, wallet switch) re-reads that page rather than skipping it;
  //  - at most CONTROL_PAGE_BUDGET pages a pass; the next pass resumes from the stored cursor;
  //  - re-reading is harmless: applyControl ignores a root it already holds, archives an older
  //    one, and a photo control not newer than the last one applied.
  async _catchUpControlByRecipient(events) {
    const wallet = this.walletAddress;
    if (!wallet || typeof this.engine.scanGroupControlByRecipientPage !== "function") return;
    const indexer = String(this.engine.groupIndexerUrl?.() || "");
    const stored = this.groupControlCursor(wallet);
    let cursor = stored && String(stored.indexer || "") === indexer && stored.cursor ? String(stored.cursor) : null;
    // Newest block time read up to `cursor`: all a rewind has to go on, the cursor being opaque.
    let at = cursor ? Number(stored.at) || 0 : 0;
    const rewinds = this._cursorRewinds;
    for (let pagesLeft = CONTROL_PAGE_BUDGET; pagesLeft > 0; pagesLeft -= 1) {
      if (this.walletAddress !== wallet) return; // switched mid-walk: the cursor is not this wallet's
      const page = await this.engine.scanGroupControlByRecipientPage(cursor, CONTROL_PAGE_LIMIT);
      if (this.walletAddress !== wallet) return;
      for (const row of page?.rows || []) {
        at = Math.max(at, Number(row.blockTime) || 0);
        // One row that throws must not pin the cursor in front of it forever.
        try {
          const ev = await this.applyControl(row.payloadString, row.sender, row.blockTime);
          // when it happened, so the UI can tell news from history replayed on an import
          if (ev) events.push({ ...ev, blockTime: row.blockTime ?? null });
        } catch (error) {
          this.engine.log?.(`Group control row skipped: ${error?.message || error}`);
        }
      }
      const next = page?.nextCursor != null ? String(page.nextCursor) : null;
      const advanced = next != null && next !== cursor;
      if (advanced) cursor = next;
      const atEnd = Number(page?.rawCount ?? page?.rows?.length ?? 0) < CONTROL_PAGE_LIMIT || !advanced;
      if (rewinds !== this._cursorRewinds) return; // rewound under this walk: the rewind stands
      if (cursor) this._saveGroupControlCursor(wallet, { cursor, indexer, caughtUp: atEnd, ...(at ? { at } : {}) });
      if (atEnd) return;
    }
    // Budget spent mid-stream: the walk up to `cursor` was contiguous, so the next pass resumes
    // from it and loses nothing (already stored above, marked not caught up).
  }

  // --- group invites (iOS bfe9f022) ---
  _loadInvites() {
    const list = loadJsonMap(GROUP_INVITES_KEY)[this.walletAddress];
    return Array.isArray(list) ? list : [];
  }
  _saveInvites(list) {
    const all = loadJsonMap(GROUP_INVITES_KEY);
    if (list.length) all[this.walletAddress] = list;
    else delete all[this.walletAddress];
    saveJsonMap(GROUP_INVITES_KEY, all);
  }
  _inviteAnswers() {
    const held = loadJsonMap(GROUP_INVITE_ANSWERS_KEY)[this.walletAddress] || {};
    return {
      accepted: Array.isArray(held.accepted) ? held.accepted : [],
      published: Array.isArray(held.published) ? held.published : [],
      statusOutbox: Array.isArray(held.statusOutbox) ? held.statusOutbox : [],
    };
  }
  _saveInviteAnswers(answers) {
    const all = loadJsonMap(GROUP_INVITE_ANSWERS_KEY);
    all[this.walletAddress] = answers;
    saveJsonMap(GROUP_INVITE_ANSWERS_KEY, all);
  }

  /** Invites waiting for an answer, newest first, leaving out any group this device has since come
   *  to hold (a Nextcloud restore brings joined groups back on its own). */
  pendingGroupInvites() {
    return this._loadInvites()
      .filter((invite) => invite.rejected !== true && !this.getGroup(invite.groupId))
      .sort((a, b) => Number(b.invitedAt || 0) - Number(a.invitedAt || 0))
      .map((invite) => {
        const latest = invite.roots[invite.roots.length - 1];
        return { id: inviteKeyOf(invite), groupId: invite.groupId, adminAddress: invite.adminAddress, invitedAt: invite.invitedAt, name: latest.name || "Group", members: latest.members || [] };
      });
  }

  /** A root for a group this wallet doesn't hold. Returns an "invite" event for one newly waiting. */
  async _holdInvite(payload, senderAddress, blockTime) {
    const me = String(this.walletAddress || "").toLowerCase();
    const includesMe = (payload.members || []).some((address) => String(address || "").toLowerCase() === me);
    const adminPub = String(payload.admin_signing_pub || "").toLowerCase();
    let adminAddress = null;
    for (const address of payload.members || []) {
      let pub = null;
      try { pub = await this.engine.xOnlyPubKeyForAddress(address); } catch { pub = null; }
      if (pub && pub.toLowerCase() === adminPub) { adminAddress = address; break; }
    }
    adminAddress = adminAddress || senderAddress || null;
    return this._withGroupLock(() => {
      if (this.isGroupTombstoned(payload.group_id, adminPub) || this.getGroup(payload.group_id)) return null;
      const key = G.groupInviteKey(payload.group_id, adminPub);
      const invites = this._loadInvites();
      const index = invites.findIndex((invite) => inviteKeyOf(invite) === key);
      if (index >= 0) {
        // Later roots of the same invite, from the same admin: the group's history if you join.
        // One that leaves you out takes the invite back. A different admin's root for this id is
        // its own invite, so whoever got here first can't shut the real one out.
        const invite = invites[index];
        const latest = invite.roots[invite.roots.length - 1];
        // A signed roster isn't replaced by an unsigned or older one for the same epoch.
        const heldVersion = invite.roots.find((root) => Number(root.epoch) === Number(payload.epoch))?.roster_version;
        if (heldVersion != null && Number(payload.roster_version || 0) < Number(heldVersion)) return null;
        if (Number(payload.epoch) >= Number(latest.epoch) && !includesMe) {
          invites.splice(index, 1);
        } else {
          invite.roots = invite.roots.filter((root) => Number(root.epoch) !== Number(payload.epoch));
          invite.roots.push(payload);
          invite.roots.sort((a, b) => Number(a.epoch) - Number(b.epoch));
          invite.invitedAt = Math.max(Number(invite.invitedAt || 0), Number(blockTime) || 0);
        }
        this._saveInvites(invites);
        return null;
      }
      // Someone you rejected stays ignored, in groups too.
      if (!includesMe || !adminAddress || this.isInviterBlocked?.(adminAddress)) return null;
      // By signing key: the address can fall back to whoever delivered the root.
      const waiting = invites.filter((invite) => invite.rejected !== true);
      const fromAdmin = waiting.filter((invite) => String(invite.roots[invite.roots.length - 1].admin_signing_pub || "").toLowerCase() === adminPub);
      if (waiting.length >= MAX_PENDING_GROUP_INVITES || fromAdmin.length >= MAX_PENDING_GROUP_INVITES_PER_ADMIN) {
        this.engine.log?.("Too many group invites waiting; dropped one.");
        return null;
      }
      invites.push({ groupId: payload.group_id, adminAddress, invitedAt: Number(blockTime) || 0, roots: [payload] });
      this._saveInvites(invites);
      return { kind: "invite", id: key, groupId: payload.group_id, name: payload.name || "Group", adminAddress, invitedAt: Number(blockTime) || 0 };
    });
  }

  /** Newest root first, so the older ones only fill in history and nothing reads as a membership
   *  change. A device holds one group per id, so another admin's offer of it goes too, unless it's
   *  only waiting to say you declined. Returns the "joined" event. */
  async _joinInvite(invite) {
    const key = inviteKeyOf(invite);
    this._saveInvites(this._loadInvites().filter((entry) => entry.groupId !== invite.groupId
      || (entry.rejected === true && inviteKeyOf(entry) !== key)));
    let joined = null;
    for (const root of [...invite.roots].sort((a, b) => Number(b.epoch) - Number(a.epoch))) {
      const event = await this._applyRoot(root, invite.adminAddress, invite.invitedAt);
      if (!joined && event?.kind === "joined") joined = { ...event, inviteAt: invite.invitedAt };
    }
    return joined;
  }

  /** Accept: the group is joined now and its history comes in with the next sync. The answer goes
   *  on chain, encrypted: to your own devices, and to the group as a status message. */
  async acceptGroupInvite(key) {
    const invite = this._loadInvites().find((entry) => inviteKeyOf(entry) === key);
    if (!invite) return null;
    const answers = this._inviteAnswers();
    if (!answers.accepted.includes(key)) answers.accepted.push(key);
    if (!answers.statusOutbox.includes(invite.groupId)) answers.statusOutbox.push(invite.groupId);
    this._saveInviteAnswers(answers);
    const joined = await this._joinInvite(invite);
    Promise.resolve().then(() => this._publishGroupAnswers()).catch(() => {});
    return joined;
  }

  /** Reject: this admin's offer is never made again, here or after a restore (the same on-chain
   *  delete marker a deleted group publishes), and its members see you declined. The invite's keys
   *  stay only until that message has gone out, since they're what it's sent with. */
  rejectGroupInvite(key) {
    const invites = this._loadInvites();
    const invite = invites.find((entry) => inviteKeyOf(entry) === key);
    if (!invite) return;
    invite.rejected = true;
    this._saveInvites(invites);
    const { groupId } = invite;
    const admin = key.split(":")[1];
    this._recordTombstone(groupId, admin, { published: false });
    Promise.resolve()
      .then(() => this._publishTombstone(groupId, admin)).catch(() => {})
      .then(() => this._publishGroupAnswers()).catch(() => {});
  }

  /** Sends every answer still owed. Each is a transaction, so one that can't go yet (no funds, no
   *  connection) waits for the next sync, like a delete marker. */
  async _publishGroupAnswers() {
    if (this._publishingAnswers) return;
    this._publishingAnswers = true;
    try {
      for (const key of this._inviteAnswers().accepted) {
        if (this._inviteAnswers().published.includes(key)) continue;
        const [groupId, admin] = key.split(":");
        if (!admin) continue;
        try {
          const payload = G.buildSignedInviteAcceptPayload({ groupId: G.hexToBytes(groupId), adminSigningPub: G.hexToBytes(admin), signingPub: this.selfPubHex(), privateKey: this.engine.privateKeyHex });
          const encryptedHex = await this.engine.encryptGroupControl(this.walletAddress, JSON.stringify(payload));
          await this.engine.sendGroupPayload(G.buildControlPayload({ recipientXOnlyPubKey: this.selfPubHex(), encryptedHex }));
          const answers = this._inviteAnswers();
          if (!answers.published.includes(key)) answers.published.push(key);
          this._saveInviteAnswers(answers);
        } catch (error) { this.engine.log?.(`Group invite answer failed: ${error?.message || error}`); }
      }
      for (const groupId of this._inviteAnswers().statusOutbox) {
        try {
          if (this.getGroup(groupId)) {
            const { record, counter } = await this._withGroupLock(() => this._reserveCounter(groupId));
            await this._sendMemberStatus(G.MEMBER_STATUS.JOINED, {
              groupId, rootHex: record.groupRootEpochHex, blindingHex: record.blindingKeyHex, epoch: record.currentEpoch,
              deviceId: G.hexToBytes(record.deviceIdHex), counter,
            });
          }
          const answers = this._inviteAnswers();
          answers.statusOutbox = answers.statusOutbox.filter((id) => id !== groupId);
          this._saveInviteAnswers(answers);
        } catch (error) { this.engine.log?.(`Group invite answer failed: ${error?.message || error}`); }
      }
      for (const invite of this._loadInvites().filter((entry) => entry.rejected === true)) {
        try {
          const root = invite.roots[invite.roots.length - 1];
          await this._sendMemberStatus(G.MEMBER_STATUS.DECLINED, {
            groupId: invite.groupId, rootHex: root.group_root_epoch, blindingHex: root.blinding_key, epoch: root.epoch,
            deviceId: G.generateDeviceId(), counter: 1,
          });
          const key = inviteKeyOf(invite);
          this._saveInvites(this._loadInvites().filter((entry) => inviteKeyOf(entry) !== key));
        } catch (error) { this.engine.log?.(`Group invite answer failed: ${error?.message || error}`); }
      }
    } finally { this._publishingAnswers = false; }
  }

  async _sendMemberStatus(status, { groupId, rootHex, blindingHex, epoch, deviceId, counter }) {
    const payload = G.sealGroupMessage({
      plaintext: G.encodeMemberStatus(status),
      groupId: G.hexToBytes(groupId),
      epoch,
      groupRootEpoch: G.hexToBytes(rootHex),
      blindingKey: G.hexToBytes(blindingHex),
      senderAddress: this.walletAddress,
      senderPrivateKey: this.engine.privateKeyHex,
      senderXOnlyPub: this.selfPubHex(),
      deviceId,
      counter,
    });
    await this.engine.sendGroupPayload(payload);
  }

  // --- where members stand on their invite ---
  _memberStatuses(groupId) {
    return loadJsonMap(GROUP_MEMBER_STATUS_KEY)[this.walletAddress]?.[groupId] || {};
  }
  _setMemberStatus(groupId, address, status) {
    const all = loadJsonMap(GROUP_MEMBER_STATUS_KEY);
    const wallet = all[this.walletAddress] || {};
    const group = wallet[groupId] || {};
    if ((group[address] ?? null) === (status ?? null)) return false;
    if (status) group[address] = status;
    else delete group[address];
    wallet[groupId] = group;
    all[this.walletAddress] = wallet;
    saveJsonMap(GROUP_MEMBER_STATUS_KEY, all);
    return true;
  }
  /** "invited" or "declined" when there's something to say. Someone who joined is just a member. */
  inviteStatus(groupId, address) {
    const status = this._memberStatuses(groupId)[address];
    return status === G.MEMBER_STATUS.JOINED ? null : status || null;
  }
  /** A member was just invited, by this device as the group's admin. */
  markMemberInvited(groupId, address) {
    this._setMemberStatus(groupId, address, G.MEMBER_STATUS.INVITED);
  }

  /** Takes members' answers out of a batch of decoded messages: they update the member list and are
   *  never bubbles. Anything else from a member with a status on record means they're in, whether
   *  or not their answer got here. */
  _takeMemberStatuses(messages, events) {
    return messages.filter((message) => {
      const status = G.parseMemberStatus(message.plaintext);
      if (!status) {
        if (this._memberStatuses(message.groupId)[message.senderAddress]) this._setMemberStatus(message.groupId, message.senderAddress, G.MEMBER_STATUS.JOINED);
        return true;
      }
      const changed = this._setMemberStatus(message.groupId, message.senderAddress, status);
      events.push({ kind: "member-status", groupId: message.groupId, address: message.senderAddress, status, changed, txId: message.txId, blockTime: message.blockTime });
      return false;
    });
  }

  // Self-addressed, self-signed delete marker. Only our own key can produce one, and only our
  // own key can read it — see verifyTombstonePayload + the signing_pub === self check on receipt.
  async _publishTombstone(groupId, adminSigningPub = null) {
    const payload = G.buildSignedTombstonePayload({ groupId, adminSigningPub, signingPub: this.selfPubHex(), privateKey: this.engine.privateKeyHex });
    const encryptedHex = await this.engine.encryptGroupControl(this.walletAddress, JSON.stringify(payload));
    const wire = G.buildControlPayload({ recipientXOnlyPubKey: this.selfPubHex(), encryptedHex });
    await this.engine.sendGroupPayload(wire);
    this._markTombstonePublished(adminSigningPub ? G.groupInviteKey(groupId, adminSigningPub) : String(groupId));
  }

  /**
   * Import a group from a cross-platform backup archive (ChatHistoryArchive.groups). Carries
   * the full key material - including the admin's groupSeed - so a second device of the same
   * account recovers groups it created (which have no on-chain invite addressed to us) as well
   * as member groups. Returns true if a group was created or advanced to a newer epoch.
   *
   * deviceId and msgCounter are intentionally NOT taken from the archive: they are per-device
   * (spec), and reusing the exporting device's values would let this device's sends collide
   * with msg_ids the phone already used. A fresh device gets its own id and a zeroed counter.
   */
  importGroupRecord(g) {
    if (!g || !g.groupId) return false;
    const groupId = String(g.groupId);
    // A tombstoned (deleted) group is never re-created from a backup — same rule as the
    // on-chain recovery path, so a restore can't resurrect a group you deleted.
    if (this.isGroupTombstoned(groupId, g.adminSigningPub || null)) return false;
    const incomingEpoch = Number(g.currentEpoch || 0);
    const existing = this.getGroup(groupId);
    // Never downgrade to an older epoch than what we already hold.
    if (existing && Number(existing.currentEpoch || 0) > incomingEpoch) return false;

    const members = Array.isArray(g.members)
      ? g.members
          .map((m) => ({
            address: String(m.address || "").trim(),
            xOnlyPubKeyHex: m.xOnlyPubKeyHex ? String(m.xOnlyPubKeyHex) : null,
            isAdmin: Boolean(m.isAdmin),
          }))
          .filter((m) => m.address)
      : [];

    const record = {
      groupId,
      name: String(g.name || existing?.name || "Group"),
      isAdmin: Boolean(g.isAdmin),
      adminAddress: g.adminAddress ? String(g.adminAddress) : (existing?.adminAddress || null),
      adminSigningPub: g.adminSigningPub ? String(g.adminSigningPub) : (existing?.adminSigningPub || null),
      groupSeedHex: g.groupSeed ? String(g.groupSeed) : (existing?.groupSeedHex || null),
      groupRootEpochHex: g.groupRootEpoch ? String(g.groupRootEpoch) : (existing?.groupRootEpochHex || null),
      blindingKeyHex: g.blindingKey ? String(g.blindingKey) : (existing?.blindingKeyHex || null),
      currentEpoch: incomingEpoch,
      deviceIdHex: existing?.deviceIdHex || G.bytesToHex(G.generateDeviceId()),
      msgCounter: existing && Number(existing.currentEpoch || 0) === incomingEpoch ? (existing.msgCounter || 0) : 0,
      members: members.length ? members : (existing?.members || []),
      cursors: existing?.cursors || {},
      cursorTimes: existing?.cursorTimes || {},
      formerMembers: existing?.formerMembers || [],
      photoHex: g.photo ? String(g.photo) : (existing?.photoHex || null),
      updatedAt: existing?.updatedAt || 0,
    };
    if (!record.groupRootEpochHex || !record.blindingKeyHex) return false; // unusable without keys
    this._put(record);
    return true;
  }

  // --- roster helper: resolve each address to its x-only pubkey ---
  async _buildRoster(memberAddresses, adminAddress) {
    const seen = new Set();
    const roster = [];
    for (const address of [adminAddress, ...memberAddresses]) {
      const addr = String(address || "").trim();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      const xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr);
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: addr === adminAddress });
    }
    return roster;
  }

  // --- create (admin) ---
  // Generates the group, persists the admin's GroupBag, and distributes gctl_root
  // to every member (including self is skipped — we already hold the keys).
  async createGroup({ name, memberAddresses = [] }) {
    const adminAddress = this.walletAddress;
    if (!adminAddress) throw new Error("Load a wallet before creating a group.");
    const roster = await this._buildRoster(memberAddresses, adminAddress);
    if (roster.length < 2) throw new Error("A group needs at least one other member.");
    if (roster.length > 50) throw new Error("A group can have at most 50 members.");

    const groupSeed = G.generateGroupSeed();
    const groupId = G.deriveGroupId(groupSeed);
    const epoch = 0;
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupId, epoch);
    const blindingKey = G.deriveBlindingKey(groupSeed, groupId);
    const deviceId = G.generateDeviceId();
    const adminSigningPub = this.selfPubHex();

    const record = {
      groupId: G.bytesToHex(groupId),
      name: String(name || "Group"),
      isAdmin: true,
      adminAddress,
      adminSigningPub,
      groupSeedHex: G.bytesToHex(groupSeed), // admin-only: lets us re-derive any epoch
      groupRootEpochHex: G.bytesToHex(groupRootEpoch),
      blindingKeyHex: G.bytesToHex(blindingKey),
      currentEpoch: epoch,
      // When THIS device learned about the group. Anything mined before it is history, not new
      // mail - see the backfill floor in maybeNotifyGroupIncoming.
      learnedAtMs: Date.now(),
      deviceIdHex: G.bytesToHex(deviceId),
      msgCounter: 0,
      members: roster,
      cursors: {},
      updatedAt: 0,
    };
    this._put(record);
    for (const member of roster) if (!member.isAdmin) this.markMemberInvited(record.groupId, member.address);
    // The group is already created and persisted. A failed invite broadcast (transient node
    // / balance / network) must NOT block the admin from entering the new group — surface it
    // as a soft warning and let it be retried (re-adding a member re-distributes the root).
    try {
      await this._distributeRoot(record, epoch);
    } catch (error) {
      // After the sends: onto a fresh read, not the pre-send copy (DSK-053).
      const inviteWarning = error?.message || String(error);
      record.inviteWarning = inviteWarning;
      await this._mutateLocked(record.groupId, (fresh) => { fresh.inviteWarning = inviteWarning; });
    }
    return this.getGroup(record.groupId) || record;
  }

  // The version for the next signed roster: the time in ms, so the admin's devices agree without
  // sharing a counter, and always above the last one this device saw, so a clock set back can't get
  // the admin's own changes refused. Recorded on a fresh read of the record (iOS nextRosterVersion).
  async _nextRosterVersion(groupId) {
    let version = Date.now();
    await this._mutateLocked(groupId, (fresh) => {
      version = Math.max(version, Number(fresh.rosterVersion || 0) + 1);
      fresh.rosterVersion = version;
    });
    return version;
  }

  // Build + encrypt + broadcast a gctl_root to every non-self member at `epoch`.
  async _distributeRoot(record, epoch) {
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupId = G.hexToBytes(record.groupId);
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupId, epoch);
    const blindingKey = G.hexToBytes(record.blindingKeyHex);
    const memberAddresses = record.members.map((m) => m.address);
    const payload = G.buildSignedRootPayload({
      groupId, epoch, groupRootEpoch, blindingKey,
      adminSigningPub: record.adminSigningPub, members: memberAddresses,
      name: record.name, adminPrivateKey: this.engine.privateKeyHex,
      rosterVersion: await this._nextRosterVersion(record.groupId),
    });
    const json = JSON.stringify(payload);
    // Each member's invite is its own self-spend tx. Send them per-member and resiliently:
    // one member failing must NOT abort the others (that's how a second member — e.g. the
    // iPhone one — was silently dropped). Retry each send a few times with a short delay,
    // because back-to-back sends contend for the same UTXO until the prior tx's change output
    // settles, so a bare second send often fails until it does.
    const failures = [];
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue; // we already have the keys
      try {
        await this._sendControlToMember(member, json);
      } catch (error) {
        failures.push({ address: member.address, message: error?.message || String(error) });
      }
    }
    // Self-addressed copy WITH the group seed, so a seedless re-import of this wallet
    // rediscovers and fully rebuilds the group from chain alone (no cloud backup). This is
    // what closes the "admin groups vanish on fresh import" gap. Best-effort: a failure here
    // never blocks member delivery, and the backfill in syncGroups retries it.
    try {
      const selfMember = { address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() };
      const selfPayload = G.buildSignedRootPayload({
        groupId, epoch, groupRootEpoch, blindingKey,
        adminSigningPub: record.adminSigningPub, members: memberAddresses,
        name: record.name, adminPrivateKey: this.engine.privateKeyHex,
        groupSeed, // the extra field ONLY the self copy carries
        rosterVersion: await this._nextRosterVersion(record.groupId),
      });
      await this._sendControlToMember(selfMember, JSON.stringify(selfPayload));
      // Mark this epoch's recovery invite as published - on a fresh read, after every send above
      // (writing `record` back here would undo whatever landed meanwhile, DSK-053), and only while
      // it is still the current epoch (a later one needs its own).
      record.selfInviteEpoch = epoch;
      await this._mutateLocked(record.groupId, (fresh) => {
        if (Number(fresh.currentEpoch || 0) !== Number(epoch)) return false;
        fresh.selfInviteEpoch = epoch;
        return true;
      });
    } catch (error) {
      // Leave selfInviteEpoch unset so syncGroups' backfill retries.
      this.engine.log?.(`Group self-invite send failed: ${error?.message || error}`);
    }
    if (failures.length) {
      const err = new Error(`${failures.length} of ${record.members.length - 1} invite(s) could not be sent`);
      err.failures = failures;
      throw err;
    }
  }

  // Encrypt + broadcast one member's gctl_root, retrying to ride out UTXO contention from a
  // just-sent sibling tx (the change output needs a moment to become spendable again).
  // A send whose outcome is unknown may have landed, so it is never sent again (that would be a
  // second transaction and fee for the same control), and a retry never goes out once another
  // account is active (it would be signed and paid for by that account).
  async _sendControlToMember(member, json, { attempts = 4, delayMs = 1800 } = {}) {
    const wallet = this.walletAddress;
    const encryptedHex = await this.engine.encryptGroupControl(member.address, json);
    const wire = G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex });
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      if (this.walletAddress !== wallet) throw lastError || new Error(SEND_ACCOUNT_CHANGED);
      try { return await this.engine.sendGroupPayload(wire); }
      catch (error) {
        lastError = error;
        if (error?.code === SEND_OUTCOME_UNKNOWN) throw error;
        if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  // --- membership changes (admin), each bumps the epoch and re-distributes ---
  // `onProgress({ stage, done, total })` reports each on-chain step of the key rotation, so a
  // screen can show that real work (one transaction per member, twice) is happening.
  async addMember(groupId, address, { onProgress = null } = {}) {
    const addr = String(address || "").trim();
    {
      const record = this._requireAdmin(groupId);
      if (record.members.some((m) => m.address === addr)) return record;
      if (record.members.length >= 50) throw new Error("A group can have at most 50 members.");
    }
    onProgress?.({ stage: "Looking up the new member's key", done: 0, total: 1 });
    const xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr);
    // The lookup awaited: re-read the record and re-check before rotating (DSK-053), so a send or
    // control applied meanwhile is not written over by the copy read above.
    const record = await this._withGroupLock(() => {
      const fresh = this._requireAdmin(groupId);
      if (fresh.members.some((m) => m.address === addr)) return null;
      if (fresh.members.length >= 50) throw new Error("A group can have at most 50 members.");
      fresh.members.push({ address: addr, xOnlyPubKeyHex, isAdmin: false });
      return this._bumpEpoch(fresh);
    });
    if (!record) return this.getGroup(groupId);
    this.markMemberInvited(groupId, addr);
    return this._rotateEpoch(record, "add", onProgress);
  }
  async removeMember(groupId, address) {
    const addr = String(address || "").trim();
    const record = await this._withGroupLock(() => {
      const fresh = this._requireAdmin(groupId);
      if (addr === fresh.adminAddress) throw new Error("The admin can't be removed.");
      fresh.formerMembers = withFormerMembers(fresh.formerMembers, fresh.members.filter((m) => m.address === addr), Number(fresh.currentEpoch || 0), 0);
      fresh.members = fresh.members.filter((m) => m.address !== addr);
      return this._bumpEpoch(fresh);
    });
    this._setMemberStatus(groupId, addr, null);
    return this._rotateEpoch(record, "remove");
  }
  async renameGroup(groupId, name) {
    const record = await this._withGroupLock(() => {
      const fresh = this._requireAdmin(groupId);
      fresh.name = String(name || fresh.name);
      fresh.updatedAt = 0;
      return this._put(fresh);
    });
    // Rename is not a forward-secrecy event — re-send the root at the SAME epoch.
    await this._distributeRoot(record, record.currentEpoch);
    return this.getGroup(groupId) || record;
  }

  // The state change of a rotation, on a record the caller just read inside the lock: next
  // epoch, its root, counter back to 0 (a new root is a new key, so msg_id 0 is fresh again).
  // Synchronous - the announcements and root sends follow in _rotateEpoch, outside the lock.
  _bumpEpoch(record) {
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupId = G.hexToBytes(record.groupId);
    const newEpoch = Number(record.currentEpoch || 0) + 1;
    record.currentEpoch = newEpoch;
    record.groupRootEpochHex = G.bytesToHex(G.deriveGroupRootEpoch(groupSeed, groupId, newEpoch));
    record.msgCounter = 0; // counter resets when the epoch advances
    return this._put(record);
  }

  // Sends for a rotation already applied by _bumpEpoch. `record` is only read here (roster, seed,
  // photo of the epoch just rotated to); every later write goes onto a fresh read (DSK-053).
  async _rotateEpoch(record, reason, onProgress = null) {
    const groupId = G.hexToBytes(record.groupId);
    const newEpoch = record.currentEpoch;
    // Announce, then hand out the new root (removed members never get it).
    const epochPayload = G.buildSignedEpochPayload({ groupId, epoch: newEpoch, reason, adminPrivateKey: this.engine.privateKeyHex });
    const epochJson = JSON.stringify(epochPayload);
    const others = record.members.filter((m) => m.address !== this.walletAddress);
    // Two transactions per member (the epoch announcement, then the new root) plus the photo
    // when the group has one - the bar is fed per transaction.
    const total = others.length * 2 + (record.photoHex ? others.length : 0);
    let done = 0;
    let index = 0;
    for (const member of others) {
      index += 1;
      onProgress?.({ stage: `Announcing the new group key (${index} of ${others.length})`, done, total });
      const encryptedHex = await this.engine.encryptGroupControl(member.address, epochJson);
      await this.engine.sendGroupPayload(G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex }));
      done += 1;
    }
    onProgress?.({ stage: `Sending the new group key to ${others.length} member${others.length === 1 ? "" : "s"}`, done, total });
    await this._distributeRoot(record, newEpoch);
    done += others.length;
    // A newly-added member should also receive the current group photo (root doesn't carry it).
    if (record.photoHex) {
      onProgress?.({ stage: "Sending the group photo", done, total });
      try { await this._distributePhoto(record); } catch {}
      done += others.length;
    }
    onProgress?.({ stage: "Done", done: total, total });
    return this.getGroup(record.groupId) || record;
  }

  _requireAdmin(groupId) {
    const record = this.getGroup(groupId);
    if (!record) throw new Error("Group not found.");
    if (!record.isAdmin) throw new Error("Only the group admin can do that.");
    return record;
  }

  // Re-broadcast the CURRENT epoch's root to every member (admin) — used to retry invites
  // that failed to send at create time, without rotating the epoch. Throws (with .failures)
  // if any member still can't be reached.
  async resendInvites(groupId) {
    const record = this._requireAdmin(groupId);
    await this._distributeRoot(record, record.currentEpoch);
    // After the sends: onto a fresh read, not the copy read before them (DSK-053).
    await this._mutateLocked(groupId, (fresh) => { delete fresh.inviteWarning; });
    // Also re-push the group photo so anyone who missed it (or a new device) catches up.
    if (record.photoHex) { try { await this._distributePhoto(record); } catch {} }
    return this.getGroup(groupId) || record;
  }

  // Re-broadcast the current root to ONE member (admin) — a targeted retry of a single failed
  // invite, no epoch rotation. Throws if the send fails.
  async resendInviteToMember(groupId, address) {
    const record = this._requireAdmin(groupId);
    const member = record.members.find((m) => m.address === address);
    if (!member) throw new Error("That member is not in the group.");
    if (member.address === this.walletAddress) return record; // never invite ourselves
    const groupSeed = G.hexToBytes(record.groupSeedHex);
    const groupIdBytes = G.hexToBytes(record.groupId);
    const groupRootEpoch = G.deriveGroupRootEpoch(groupSeed, groupIdBytes, record.currentEpoch);
    const blindingKey = G.hexToBytes(record.blindingKeyHex);
    const payload = G.buildSignedRootPayload({
      groupId: groupIdBytes, epoch: record.currentEpoch, groupRootEpoch, blindingKey,
      adminSigningPub: record.adminSigningPub, members: record.members.map((m) => m.address),
      name: record.name, adminPrivateKey: this.engine.privateKeyHex,
      rosterVersion: await this._nextRosterVersion(record.groupId),
    });
    await this._sendControlToMember(member, JSON.stringify(payload));
    return record;
  }

  // Admin: set (photoHex = hex of a compressed JPEG) or clear (photoHex = "") the group photo,
  // then push it to every member via a signed gctl_photo control message.
  async setGroupPhoto(groupId, photoHex) {
    const record = await this._withGroupLock(() => {
      const fresh = this._requireAdmin(groupId);
      fresh.photoHex = String(photoHex || "");
      return this._put(fresh);
    });
    await this._distributePhoto(record);
    return this.getGroup(groupId) || record;
  }

  // Send the current group photo to every member (admin). Best-effort; throws with .failures set
  // if any member couldn't be reached, so the caller can surface a "some didn't receive it" note.
  async _distributePhoto(record) {
    const payload = G.buildSignedPhotoPayload({
      groupId: G.hexToBytes(record.groupId),
      photoHex: record.photoHex || "",
      signingPub: this.selfPubHex(),
      privateKey: this.engine.privateKeyHex,
    });
    const json = JSON.stringify(payload);
    let failures = 0;
    for (const member of record.members) {
      if (member.address === this.walletAddress) continue;
      try { await this._sendControlToMember(member, json); } catch { failures += 1; }
    }
    // Also send a self-addressed copy so the SAME account's OTHER devices pick up the photo change
    // (they scan for controls addressed to their own key). Best-effort; not counted as a failure.
    try { await this._sendControlToMember({ address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() }, json); } catch {}
    if (failures) { const e = new Error(`${failures} member(s) may not have received the photo yet.`); e.failures = failures; throw e; }
  }

  // --- send a message ---
  async sendGroupMessage(groupId, plaintext, { feeKas = "0" } = {}) {
    // Reserve the counter BEFORE sending so a retry never reuses a msg_id. Under the group lock,
    // on a fresh read, against the monotonic high-water mark (DSK-053): a scan that wrote back an
    // older copy of the record can no longer hand the same counter out twice. The seal below uses
    // the epoch, root and device id of that same read, so they match the mark just raised.
    const { record, counter } = await this._withGroupLock(() => this._reserveCounter(groupId));
    const payload = G.sealGroupMessage({
      plaintext,
      groupId: G.hexToBytes(record.groupId),
      epoch: record.currentEpoch,
      groupRootEpoch: G.hexToBytes(record.groupRootEpochHex),
      blindingKey: G.hexToBytes(record.blindingKeyHex),
      senderAddress: this.walletAddress,
      senderPrivateKey: this.engine.privateKeyHex,
      senderXOnlyPub: this.selfPubHex(),
      deviceId: G.hexToBytes(record.deviceIdHex),
      counter,
    });
    const msgIdHex = G.bytesToHex(G.buildMsgId(G.hexToBytes(record.deviceIdHex), counter));
    const result = await this.engine.sendGroupPayload(payload, { feeKas: String(feeKas || "0") });
    return { txid: result?.txids?.[0] || null, counter, epoch: record.currentEpoch, msgIdHex };
  }

  // --- apply an incoming control message (gctl_root / gctl_epoch) ---
  // `senderAddress` comes from the indexer row. Returns a small event describing
  // what changed, or null if it wasn't for us / was invalid / was stale.
  async applyControl(payloadString, senderAddress, blockTime = 0) {
    const parsed = G.parseControlPayload(payloadString);
    if (!parsed) return null;
    // The indexer strips the recipient in REST responses, so parsed.recipientXOnlyPubKey
    // is usually null here. When it IS present (live wire / our own echo) we can fast-skip
    // controls addressed to someone else; otherwise we just try to decrypt — a control that
    // isn't ours fails ECIES and returns null, exactly as iOS relies on.
    if (parsed.recipientXOnlyPubKey && G.bytesToHex(parsed.recipientXOnlyPubKey) !== this.selfPubHex()) return null;
    let json;
    try { json = await this.engine.decryptGroupControl(parsed.encryptedHex); }
    catch { return null; } // not decryptable by us
    let payload;
    try { payload = JSON.parse(json); } catch { return null; }

    // Decryption above and the root's roster lookups run outside the group lock; the state change
    // itself is one locked, synchronous read-decide-write (DSK-053).
    if (payload.type === "gctl_root") return this._applyRoot(payload, senderAddress, blockTime);
    // You accepted this group on another device, or before restoring these words.
    if (payload.type === "gctl_invite_accept") {
      if (payload.signing_pub !== this.selfPubHex() || !G.verifyInviteAcceptPayload(payload)) return null;
      const answers = this._inviteAnswers();
      const key = G.groupInviteKey(payload.group_id, payload.admin_signing_pub);
      if (!answers.accepted.includes(key)) answers.accepted.push(key);
      if (!answers.published.includes(key)) answers.published.push(key);
      this._saveInviteAnswers(answers);
      const invite = this._loadInvites().find((entry) => inviteKeyOf(entry) === key);
      return invite ? this._joinInvite(invite) : null;
    }
    // gctl_epoch is a heads-up only; the real state change lands on the matching gctl_root.
    if (payload.type === "gctl_epoch") return { kind: "epoch-notice", groupId: payload.group_id, epoch: payload.epoch };
    if (payload.type === "gctl_photo" || payload.type === "gctl_tombstone") {
      return this._withGroupLock(() => this._applyPhotoOrTombstone(payload, blockTime));
    }
    return null;
  }

  // Locked by the caller; synchronous: the record is read and written with nothing in between.
  _applyPhotoOrTombstone(payload, blockTime) {
    // A group photo set by the admin — apply only if signed by THIS group's known admin.
    if (payload.type === "gctl_photo") {
      const record = this.getGroup(payload.group_id);
      if (!record) return null;
      if (payload.signing_pub !== record.adminSigningPub || !G.verifyPhotoPayload(payload)) return null;
      // The by-recipient control scan reads from a persisted cursor (DSK-041), but historical
      // controls still come round again: the first walk after an import, a "Refresh Messages"
      // re-walk (the cursor is reset), or two passes overlapping. Photo controls oscillate
      // photoHex (set/clear), which would re-apply and re-emit a system message each time. Guard
      // by block time: ignore any photo control not strictly newer than the last one we applied.
      // (photoUpdatedAt is preserved across root rebuilds.)
      const bt = Number(blockTime || 0);
      if (bt > 0 && bt <= Number(record.photoUpdatedAt || 0)) return null;
      const newHex = String(payload.photo || "");
      const changed = (record.photoHex || "") !== newHex;
      record.photoHex = newHex;
      if (bt > 0) record.photoUpdatedAt = bt;
      this._put(record);
      // Content-stable key so the actor's own "You changed…" line and this self-echo dedupe
      // to a single message instead of doubling.
      const photoKey = newHex === "" ? "cleared" : `${newHex.length}:${newHex.slice(0, 16)}`;
      return { kind: "photo-updated", groupId: record.groupId, changed, cleared: newHex === "", photoKey, adminAddress: record.adminAddress };
    }
    // A delete marker — honor ONLY our own (signed by, and addressed to, us). Record the
    // tombstone (already on chain, so mark it published) and drop the group if we still hold it.
    if (payload.type === "gctl_tombstone") {
      if (payload.signing_pub !== this.selfPubHex() || !G.verifyTombstonePayload(payload)) return null;
      const id = String(payload.group_id).toLowerCase();
      const admin = payload.admin_signing_pub || null;
      const held = this.getGroup(id);
      this._recordTombstone(id, admin, { published: true });
      // A marker about another admin's offer of this id says nothing about the group held here.
      if (!held || (admin && String(admin).toLowerCase() !== String(held.adminSigningPub || "").toLowerCase())) return null;
      const { all, bucket } = this._bucket();
      delete bucket[id];
      all[this.walletAddress] = bucket;
      saveAll(all);
      this._dropCounterMarks(id);
      this._dropSeenIds(id);
      return { kind: "deleted", groupId: id };
    }
    return null;
  }

  // The same root seen again - a re-walk of the recipient control stream re-serves old roots -
  // changes nothing: no member lookups, no write, no event, and so no re-render of the open
  // thread (which also stopped a playing voice note). Anything that differs still applies.
  _isSameRoot(existing, payload) {
    if (!(existing && payload.epoch === existing.currentEpoch
      && payload.group_root_epoch === existing.groupRootEpochHex
      && payload.blinding_key === existing.blindingKeyHex
      && payload.admin_signing_pub === existing.adminSigningPub
      && (payload.name || existing.name || "Group") === existing.name
      && !(payload.group_seed && !existing.groupSeedHex)
      && (existing.members || []).every((m) => m.xOnlyPubKeyHex))) return false;
    const incoming = [...new Set((payload.members || []).map((a) => String(a || "").trim()).filter(Boolean))].sort();
    const held = (existing.members || []).map((m) => m.address).sort();
    return incoming.length === held.length && incoming.every((a, i) => a === held[i]);
  }

  // Who may deliver a root with no signed roster: blank, because the by-recipient endpoint returns no
  // sender until the indexer has resolved one and refusing would lose a real root as the cursor moves
  // past it, or the admin. This narrows the problem and doesn't close it (MESSAGING.md, "Limits").
  async _rootSenderAllowed(senderAddress, adminSigningPub) {
    const sender = String(senderAddress || "").trim();
    if (!sender) return true;
    let pub = null;
    try { pub = await this.engine.xOnlyPubKeyForAddress(sender); } catch { pub = null; }
    return Boolean(pub) && pub.toLowerCase() === String(adminSigningPub || "").toLowerCase();
  }

  async _applyRoot(received, senderAddress, blockTime = 0) {
    // The signature covers bytes, while everything remembered about a group is keyed by this text:
    // another spelling of an id would read as one you never answered or deleted.
    const payload = { ...received, group_id: G.canonicalHex(received.group_id), admin_signing_pub: G.canonicalHex(received.admin_signing_pub) };
    if (!G.verifyRootPayload(payload)) return null;
    // `sig` leaves out the members and name (iOS 26c4d76d, MESSAGING.md "Signed rosters"). If the
    // admin signed them, who delivered them doesn't matter, and one that fails has been edited: it
    // never falls back to the sender rule.
    if (payload.roster_sig != null || payload.roster_version != null) {
      if (!G.verifyRosterPayload(payload)) return null;
    } else if (!(await this._rootSenderAllowed(senderAddress, payload.admin_signing_pub))) {
      return null;
    }
    const groupId = payload.group_id;
    // A tombstoned group must never be re-added — this is what makes a delete survive a
    // seedless re-import against the recovery invite.
    if (this.isGroupTombstoned(groupId, payload.admin_signing_pub)) return null;
    // A first look, only to skip the work for a root that changes nothing. The decision and the
    // write happen in _commitRoot on a record read AFTER the roster lookups below (DSK-053).
    const before = this.getGroup(groupId);
    // The signature only proves the payload agrees with itself: anyone who knows a group id can
    // sign a root naming themselves admin. A group this device holds keeps the admin it has, or a
    // removed member could take it over with a higher epoch (iOS bfe9f022).
    if (before?.adminSigningPub && before.adminSigningPub.toLowerCase() !== String(payload.admin_signing_pub || "").toLowerCase()) return null;
    // Nobody joins a group by being added to it: a group this device doesn't hold waits in Message
    // Requests. Your own (the admin's recovery copy) just comes back, and so does one you already
    // said yes to: that admin's, not whoever else signs a root for this id.
    if (!before && String(payload.admin_signing_pub || "").toLowerCase() !== this.selfPubHex().toLowerCase()
      && !this._inviteAnswers().accepted.includes(G.groupInviteKey(groupId, payload.admin_signing_pub))) {
      return this._holdInvite(payload, senderAddress, blockTime);
    }
    if (before && (payload.epoch < before.currentEpoch || this._isSameRoot(before, payload))) {
      const quick = await this._withGroupLock(() => this._commitRoot(payload, senderAddress, null, null, blockTime));
      // The record moved between the two reads so that this root does apply after all: resolve
      // the roster and commit it properly.
      if (quick !== NEEDS_ROSTER) return quick;
    }

    // Admin self-recovery: a self-addressed root carries the group seed. Trust it only if it
    // re-derives the SIGNED group_id + blinding_key (that binding is what authenticates the
    // otherwise-unsigned seed). When valid, this is our own group and we rebuild it as admin.
    let recoveredSeedHex = null;
    if (payload.group_seed && payload.admin_signing_pub === this.selfPubHex()) {
      try {
        const seed = G.hexToBytes(payload.group_seed);
        const derivedId = G.bytesToHex(G.deriveGroupId(seed));
        const derivedBlinding = G.bytesToHex(G.deriveBlindingKey(seed, G.hexToBytes(groupId)));
        if (derivedId === groupId && derivedBlinding === payload.blinding_key) recoveredSeedHex = G.bytesToHex(seed);
      } catch { recoveredSeedHex = null; }
    }
    const isAdminRecord = recoveredSeedHex != null;

    // Resolve each member address to its pubkey for the local roster.
    const roster = [];
    for (const address of payload.members || []) {
      const addr = String(address || "").trim();
      if (!addr || roster.some((m) => m.address === addr)) continue;
      let xOnlyPubKeyHex = null;
      try { xOnlyPubKeyHex = await this.engine.xOnlyPubKeyForAddress(addr); } catch { xOnlyPubKeyHex = null; }
      // For an admin record the admin is ourselves; otherwise whoever holds the admin's key, since
      // a signed root can come from any member.
      const memberIsAdmin = isAdminRecord ? addr === this.walletAddress
        : (xOnlyPubKeyHex ? xOnlyPubKeyHex.toLowerCase() === payload.admin_signing_pub : addr === senderAddress);
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: memberIsAdmin });
    }
    const result = await this._withGroupLock(() => this._commitRoot(payload, senderAddress, roster, recoveredSeedHex, blockTime));
    return result === NEEDS_ROSTER ? null : result;
  }

  // Locked by the caller; synchronous. Decides on, and writes, a record read right here - after
  // the roster lookups, never before them (DSK-053): a counter reserved, a photo set or another
  // root applied while those awaited is carried into the new record instead of being dropped.
  // With `roster` null (the quick path) it only archives / skips, and returns NEEDS_ROSTER when
  // the root turns out to need applying.
  _commitRoot(received, senderAddress, heldRoster, recoveredSeedHex, blockTime = 0) {
    let payload = received;
    let roster = heldRoster;
    const groupId = payload.group_id;
    if (this.isGroupTombstoned(groupId, payload.admin_signing_pub)) return null;
    const existing = this.getGroup(groupId);
    // Read again here, after the lookups: see _applyRoot.
    if (existing?.adminSigningPub && existing.adminSigningPub.toLowerCase() !== String(payload.admin_signing_pub || "").toLowerCase()) return null;
    // A root for an OLDER epoch is not an attack to drop on the floor - it is history this device
    // may no longer hold. Archiving it is strictly additive: currentEpoch and the current root are
    // untouched, so there is no downgrade. It is also what makes re-walking the control stream
    // actually repair a thread - without it a refresh re-downloads pre-rotation ciphertext it
    // still has no key for, which is why refreshing appeared to do nothing. iOS archives it in
    // archivePreviousRoot; Android in completeJoin.
    if (existing && payload.epoch < existing.currentEpoch) {
      this._archivePreviousRoot(existing, payload.epoch, payload.group_root_epoch);
      return null;
    }
    // After a signed roster, an unsigned or older one can't change the name or members. A newer
    // epoch's keys still count, since only the admin can sign those: an admin device on an older app
    // would otherwise cut every member off from the group's new messages.
    if (existing?.rosterVersion != null && Number(payload.roster_version || 0) < Number(existing.rosterVersion)) {
      if (!(payload.epoch > existing.currentEpoch)) return null;
      const { roster_version: _version, roster_sig: _sig, ...keysOnly } = payload;
      payload = { ...keysOnly, members: (existing.members || []).map((m) => m.address), name: existing.name };
      roster = (existing.members || []).map((m) => ({ ...m }));
    }
    if (this._isSameRoot(existing, payload)) {
      // Nothing to show, but a newer signature still moves the pin.
      if (Number(payload.roster_version || 0) > Number(existing.rosterVersion || 0)) {
        existing.rosterVersion = Number(payload.roster_version);
        this._put(existing);
      }
      return null;
    }
    if (!roster) return NEEDS_ROSTER;
    const isAdminRecord = recoveredSeedHex != null;

    const isNewEpoch = !existing || payload.epoch > existing.currentEpoch;
    const record = {
      groupId,
      name: payload.name || existing?.name || "Group",
      isAdmin: isAdminRecord || existing?.isAdmin === true,
      adminAddress: isAdminRecord ? this.walletAddress : (roster.find((m) => m.isAdmin)?.address || existing?.adminAddress || senderAddress || null),
      adminSigningPub: payload.admin_signing_pub,
      // Keep any seed we already hold; adopt a validly-recovered one on a seedless rebuild.
      groupSeedHex: recoveredSeedHex || existing?.groupSeedHex || null,
      groupRootEpochHex: payload.group_root_epoch,
      blindingKeyHex: payload.blinding_key,
      currentEpoch: payload.epoch,
      // Set once, on the root that first told us this group exists, and preserved across every
      // later epoch rotation - an add/remove must not reset the backfill floor and re-arm a
      // flood of banners for messages already read.
      learnedAtMs: existing?.learnedAtMs || Date.now(),
      // Retired epochs' roots, so pre-rotation messages stay readable. Carried across rebuilds -
      // losing them would put those messages permanently out of reach for a non-admin - and the
      // root we are replacing right now is added to them. Waiting for that older root to come
      // round again on the control stream would be leaving it to chance; we are holding it at
      // exactly this moment, and keeping it costs one hex string.
      previousRootsHex: (() => {
        const roots = { ...(existing?.previousRootsHex || {}) };
        if (isNewEpoch && existing?.groupRootEpochHex && existing.currentEpoch != null) {
          roots[String(existing.currentEpoch)] = existing.groupRootEpochHex;
        }
        return roots;
      })(),
      // Joining a group, or having its roster change, can make history readable that was not a
      // moment ago - and the scan advances its cursor past anything it could not decode. Re-walk
      // once from the start so that history is actually asked for. Idempotent: the app dedupes on
      // msg_id and txid.
      cursors: isNewEpoch ? {} : (existing?.cursors || {}),
      cursorTimes: isNewEpoch ? {} : (existing?.cursorTimes || {}),
      // device_id is preserved across updates; counter resets only when the epoch advances.
      deviceIdHex: existing?.deviceIdHex || G.bytesToHex(G.generateDeviceId()),
      msgCounter: isNewEpoch ? 0 : (existing?.msgCounter || 0),
      members: roster,
      // Who this root takes out: what they said while they were in still counts on a late catch-up.
      formerMembers: withFormerMembers(
        existing?.formerMembers,
        (existing?.members || []).filter((m) => !roster.some((next) => next.address === m.address)),
        payload.epoch > 0 ? payload.epoch - 1 : 0,
        blockTime,
      ),
      // A recovered admin group already has its recovery invite on chain for this epoch.
      selfInviteEpoch: isAdminRecord ? payload.epoch : existing?.selfInviteEpoch,
      // The newest signed roster applied here: an unsigned or older root can't change the name or
      // members after it. An admin also uses it so its next version is always higher.
      rosterVersion: payload.roster_version != null ? Math.max(Number(payload.roster_version), Number(existing?.rosterVersion || 0)) : existing?.rosterVersion,
      // Group photo isn't carried in the root (separate gctl_photo control) — preserve it.
      photoHex: existing?.photoHex || null,
      photoUpdatedAt: existing?.photoUpdatedAt || 0,
      updatedAt: 0,
    };
    this._put(record);
    const kind = existing ? "root-updated" : (isAdminRecord ? "recovered" : "joined");
    // Membership diff, so the UI can show iMessage-style "X was added/removed" lines to every
    // member on a key rotation. Only for an already-known group (a first join has no baseline).
    let added = [], removed = [];
    if (existing) {
      const oldAddrs = new Set((existing.members || []).map((m) => m.address));
      const newAddrs = new Set(roster.map((m) => m.address));
      added = roster.map((m) => m.address).filter((a) => !oldAddrs.has(a));
      removed = (existing.members || []).map((m) => m.address).filter((a) => !newAddrs.has(a));
      for (const address of added) this._setMemberStatus(groupId, address, G.MEMBER_STATUS.INVITED);
      for (const address of removed) this._setMemberStatus(groupId, address, null);
    }
    // Surface a rename (name changed on an already-known group) so the UI can show a system line.
    const renamedTo = (existing && existing.name !== record.name) ? record.name : null;
    return { kind, groupId, epoch: payload.epoch, name: record.name, added, removed, renamedTo, adminAddress: record.adminAddress };
  }

  // --- process an incoming gcomm message ---
  // Trial-matches the parsed message's blinded id against each local group's
  // roster; on a match, verifies roster membership + sender_id, then decrypts.
  // Returns a decoded message or null.
  /// `rejections` (optional, Group Info's Refresh Messages): counts why a message for one of our
  /// groups was dropped, so "nothing recovered" says which wall the repair hit (iOS
  /// GroupRefreshRejections).
  /// `tx` is `{ txId, blockTime }` of the transaction carrying it, which is what the replay check
  /// and the former-member check go on.
  processMessage(parsed, rejections = null, tx = null) {
    if (!parsed) return null;
    for (const record of this.listGroups()) {
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      const expected = G.bytesToHex(G.deriveBlindedGroupId(blindingKey, parsed.senderPubKey));
      if (expected !== G.bytesToHex(parsed.blindedGroupId)) continue;
      // Sender must be in the roster (matched by pubkey), or have been when this was sent.
      const senderPubHex = G.bytesToHex(parsed.senderPubKey);
      const member = record.members.find((m) => m.xOnlyPubKeyHex === senderPubHex)
        || this._formerMemberAt(record, senderPubHex, parsed.epoch, tx?.blockTime);
      if (!member) { if (rejections) rejections.senderNotInRoster += 1; return null; }
      // sender_id must equal SHA256(sender_address).
      if (G.bytesToHex(G.deriveSenderId(member.address)) !== G.bytesToHex(parsed.senderId)) return null;
      // Need the epoch's root. Non-admins only hold the current epoch's root; the
      // admin can re-derive any epoch from the seed.
      let rootHex = null;
      if (parsed.epoch === record.currentEpoch) rootHex = record.groupRootEpochHex;
      else if (record.groupSeedHex) rootHex = G.bytesToHex(G.deriveGroupRootEpoch(G.hexToBytes(record.groupSeedHex), G.hexToBytes(record.groupId), parsed.epoch));
      // Last resort for a non-admin: a retired root archived when its rotation arrived.
      else rootHex = record.previousRootsHex?.[String(parsed.epoch)] || null;
      if (!rootHex) { if (rejections) rejections.noRootForEpoch += 1; return null; }
      let plaintext;
      try { plaintext = G.openGroupMessage(parsed, { groupId: G.hexToBytes(record.groupId), groupRootEpoch: G.hexToBytes(rootHex) }); }
      catch { if (rejections) rejections.decryptFailed += 1; return null; }
      // All of that passes for a copy of someone's payload in a new transaction too, so the id is
      // claimed here, before a message, reaction, edit or status can act on it.
      if (tx && !this._claimMessageId(record.groupId, parsed, tx.txId)) {
        this.engine.log?.(`Dropped a group message replay: ${tx.txId}`);
        if (rejections) rejections.replayed = (rejections.replayed || 0) + 1;
        return null;
      }
      // Past Message retention it isn't kept, even if a re-walk brings it back. A member's answer
      // to their invite isn't a stored message: it's who is in the group.
      if (tx && this._pastRetention(plaintext, tx.blockTime)) {
        if (rejections) rejections.expired = (rejections.expired || 0) + 1;
        return null;
      }
      return {
        groupId: record.groupId,
        senderAddress: member.address,
        senderIsAdmin: member.isAdmin,
        epoch: parsed.epoch,
        msgIdHex: G.bytesToHex(parsed.msgId),
        plaintext,
      };
    }
    return null;
  }

  _pastRetention(plaintext, blockTime) {
    const floor = this._retentionFloor;
    if (floor?.wallet !== this.walletAddress || !floor.cutoffMs) return false;
    const at = blockTimeMs(blockTime);
    return at > 0 && at < floor.cutoffMs && !G.parseMemberStatus(plaintext);
  }

  // --- sync: pull new controls (invites/rotations) then new messages ---
  // Returns { controls: [...events], messages: [...decoded] }. The app persists
  // decoded messages into its conversation state and renders control events.
  //
  // DSK-053: the routine pass stands down while a Refresh Messages runs (that walks the same
  // streams from the start, and owns this group's cursors until it is done), and a second call
  // while a pass is in flight does not start an overlapping one. Both return an empty result with
  // `skipped` set, which the app applies as "nothing new"; the next tick syncs as usual.
  //
  // walletAddress reads the engine live, so a pass that spans an in-place account create / import
  // would read one account's groups and write (or send, signed by the next account's key) into the
  // other's. The pass is bound to the account it started for: it stops writing and sending once
  // that changes, and its result comes back empty with `skipped: "account-changed"` (iOS dfaba68).
  async syncGroups() {
    if (this._refreshing > 0) return { controls: [], messages: [], skipped: "refreshing" };
    if (this._syncInFlight) return { controls: [], messages: [], skipped: "in-flight" };
    const wallet = this.walletAddress;
    const pass = this._syncGroupsPass(wallet);
    this._syncInFlight = pass;
    try {
      const result = await pass;
      if (this.walletAddress !== wallet) return { controls: [], messages: [], skipped: "account-changed" };
      return result;
    } finally { if (this._syncInFlight === pass) this._syncInFlight = null; }
  }

  async _syncGroupsPass(wallet = this.walletAddress) {
    const events = [];
    const switched = () => this.walletAddress !== wallet;
    if (this._sinceRewind != null) {
      this.sinceBlockTime = Math.min(this.sinceBlockTime, this._sinceRewind);
      this._sinceRewind = null;
    }
    // 0. Backfill recovery invites: publish a self-addressed root (with the group seed) for any
    // admin group that lacks one for its current epoch — i.e. every group created before this
    // feature existed. One-time per group per epoch; after it lands on chain, a seedless import
    // of this wallet rediscovers the group with no cloud backup. Best-effort, never blocks sync.
    for (const record of this.listGroups()) {
      if (switched()) return { controls: [], messages: [] };
      if (!record.isAdmin || !record.groupSeedHex) continue;
      if (record.selfInviteEpoch === record.currentEpoch) continue;
      try {
        const groupSeed = G.hexToBytes(record.groupSeedHex);
        const groupId = G.hexToBytes(record.groupId);
        const selfPayload = G.buildSignedRootPayload({
          groupId, epoch: record.currentEpoch,
          groupRootEpoch: G.hexToBytes(record.groupRootEpochHex),
          blindingKey: G.hexToBytes(record.blindingKeyHex),
          adminSigningPub: record.adminSigningPub, members: record.members.map((m) => m.address),
          name: record.name, adminPrivateKey: this.engine.privateKeyHex, groupSeed,
          rosterVersion: await this._nextRosterVersion(record.groupId),
        });
        if (switched()) return { controls: [], messages: [] };
        await this._sendControlToMember({ address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() }, JSON.stringify(selfPayload));
        // The send awaited: mark it on a fresh read, never by writing `record` back (DSK-053), and
        // only if that epoch is still current (a rotation meanwhile needs its own invite).
        const epoch = record.currentEpoch;
        if (switched()) return { controls: [], messages: [] };
        await this._mutateLocked(record.groupId, (fresh) => {
          if (Number(fresh.currentEpoch || 0) !== Number(epoch)) return false;
          fresh.selfInviteEpoch = epoch;
          return true;
        });
      } catch (error) {
        this.engine.log?.(`Group self-invite backfill failed: ${error?.message || error}`);
      }
    }
    // 0b. Backfill delete markers: publish the on-chain tombstone for any group deleted while
    // offline (or whose delete-time publish failed), so the delete survives a seedless re-import.
    {
      const { bucket } = this._tombstoneBucket();
      for (const entry of bucket.deleted) {
        if (switched()) return { controls: [], messages: [] };
        if (bucket.published.includes(entry)) continue;
        const [id, admin] = entry.split(":");
        try { await this._publishTombstone(id, admin || null); }
        catch (error) { this.engine.log?.(`Group tombstone backfill failed: ${error?.message || error}`); }
      }
    }

    if (switched()) return { controls: [], messages: [] };
    try { await this._publishGroupAnswers(); } catch { /* retried next pass */ }
    if (switched()) return { controls: [], messages: [] };

    // The indexer is down: what's missed is read from the block stream and members' REST history
    // instead, and none of its cursors move, so it serves this window again when it's back.
    this._refreshBlockStream(wallet);
    if (this.engine.shouldSkipGroupIndexer?.()) {
      await this._catchUpGroupsFromChain(wallet);
      if (switched()) return { controls: [], messages: [] };
      const fromChain = [];
      this._drainChainResults(wallet, events, fromChain);
      return { controls: events, messages: this._takeMemberStatuses(fromChain, events) };
    }

    // 1. Discover invites / rotations addressed to us, from the persisted cursor (DSK-041). The
    // by-sender read per known admin (iOS catchUpGroupControl) is not used here: by-recipient
    // already carries every control addressed to this key, admin rotations included.
    try {
      await this._catchUpControlByRecipient(events);
    } catch { /* indexer hiccup — the cursor holds at the last applied page; try messages anyway */ }

    // 2. Live traffic (iOS a56fb98): one POST /group-messages/since carrying every member's
    // blinded id of every group, starting 10 s before the last answer, rows deduped by txId.
    // The per-member cursor reads below then run as the safety net about once a minute (they
    // also advance the cursors), or on every pass on an indexer without the read.
    const messages = [];
    const records = this.listGroups();
    let usedSince = false;
    if (this.sinceSupported !== false && this.sinceBlockTime > 0 && records.length) {
      const ids = [];
      for (const record of records) {
        const blindingKey = G.hexToBytes(record.blindingKeyHex);
        for (const member of record.members) {
          if (member.xOnlyPubKeyHex) ids.push(G.bytesToHex(G.deriveBlindedGroupId(blindingKey, member.xOnlyPubKeyHex)));
        }
      }
      try {
        // A full page (`SINCE_LIMIT` rows) is followed straight away (GROUP_MESSAGES_INDEXER.md §2,
        // DSK-040): from latestBlockTime - 1, since the read is strictly newer-than, so rows that
        // share the page's newest time come back and dedupe; when that does not move (more than a
        // page shares one time) it steps to latestBlockTime. At most SINCE_MAX_PAGES per chunk; a
        // chunk that hits the cap holds the cursor at the newest row it read.
        const SINCE_LIMIT = 200;
        const SINCE_MAX_PAGES = 20;
        let latest = this.sinceBlockTime;
        let cap = Infinity;
        for (let i = 0; i < ids.length; i += 256) {
          const chunk = ids.slice(i, i + 256);
          let since = this.sinceBlockTime - 10_000;
          let full = false;
          for (let page = 0; page < SINCE_MAX_PAGES; page += 1) {
            const { messages: rows, latestBlockTime, count } = await this.engine.scanGroupMessagesSince(chunk, since, SINCE_LIMIT);
            if (switched()) return { controls: [], messages: [] };
            const pageLatest = Number(latestBlockTime) || 0;
            latest = Math.max(latest, pageLatest);
            this._withSeenIds(() => {
              for (const row of rows) {
                if (!row.txId || this._sinceSeen.has(row.txId)) continue;
                this._sinceSeen.add(row.txId);
                if (this._sinceSeen.size > 4000) { for (const old of [...this._sinceSeen].slice(0, 2000)) this._sinceSeen.delete(old); }
                const parsed = G.parseGroupMessagePayload(row.payloadString);
                const decoded = this.processMessage(parsed, null, { txId: row.txId, blockTime: row.blockTime });
                if (decoded) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
              }
            });
            full = Number(count ?? rows.length) >= SINCE_LIMIT;
            if (!full) break;
            if (pageLatest - 1 > since) since = pageLatest - 1;
            else if (pageLatest > since) since = pageLatest;
            else break; // no progress reported: leave it to the next pass / the full scan
          }
          if (full) cap = Math.min(cap, since);
        }
        this.sinceBlockTime = Math.max(this.sinceBlockTime, Math.min(latest, cap));
        this._sincePasses = (this._sincePasses || 0) + 1;
        usedSince = true;
      } catch (error) {
        if (error?.unsupported) {
          this.sinceSupported = false;
          this.engine.log?.("Group live polling: the indexer has no /group-messages/since; reading per member.");
        }
      }
    }
    const fullScan = !usedSince || this._sincePasses % 12 === 0;
    for (const record of fullScan ? records : []) {
      // `record` is read once, before the scans, and only to know which streams to read and from
      // where. It is never written back (DSK-053): a counter reserved, a rotation or a roster
      // change landing while the scans await would be rolled back by it.
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      const startCursors = record.cursors || {};
      const scans = this._laneIds(record, blindingKey);
      let next = 0;
      const results = new Array(scans.length);
      await Promise.all(Array.from({ length: Math.min(4, scans.length) }, async () => {
        while (next < scans.length) {
          const i = next++;
          try { results[i] = await this.engine.scanGroupMessages(scans[i], startCursors[scans[i]] || null); }
          catch { results[i] = null; }
        }
      }));
      // Decode and merge in one locked, synchronous step, so the keys the rows decode with are the
      // ones in the record the cursors land in. Decode sequentially in member order. The pass owns
      // only the cursors of the streams it read, and only where the stored cursor is still the one
      // it started from: a cursor reset meanwhile (a key arrived - history must be re-walked from
      // the start) or moved by another reader is left as it is.
      if (switched()) return { controls: [], messages: [] };
      await this._withGroupLock(() => {
        // Decoded with, and cursors written into, the account the pass started for only.
        if (switched()) return;
        const newest = {};
        const newestTimes = {};
        this._withSeenIds(() => results.forEach((rows, i) => {
          if (!rows) return;
          for (const row of rows) {
            const parsed = G.parseGroupMessagePayload(row.payloadString);
            const decoded = this.processMessage(parsed, null, { txId: row.txId, blockTime: row.blockTime });
            if (decoded) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
            if (row.cursor) { newest[scans[i]] = row.cursor; newestTimes[scans[i]] = Number(row.blockTime) || 0; }
          }
        }));
        if (!Object.keys(newest).length) return;
        this._mutate(record.groupId, (fresh) => {
          const cursors = { ...(fresh.cursors || {}) };
          const cursorTimes = { ...(fresh.cursorTimes || {}) };
          let changed = false;
          for (const [blindedHex, cursor] of Object.entries(newest)) {
            if ((cursors[blindedHex] || null) !== (startCursors[blindedHex] || null)) continue;
            if (cursors[blindedHex] === cursor) continue;
            cursors[blindedHex] = cursor;
            cursorTimes[blindedHex] = newestTimes[blindedHex];
            changed = true;
          }
          if (!changed) return false;
          fresh.cursors = cursors;
          fresh.cursorTimes = cursorTimes;
          return true;
        });
      });
    }
    // The first full read establishes "now"; the since reads take over from here.
    // A minute back: a computer clock running ahead must not skip the newest rows.
    if (switched()) return { controls: [], messages: [] };
    if (fullScan && !this.sinceBlockTime) this.sinceBlockTime = Date.now() - 60_000;
    // The indexer went down during this pass: what it didn't serve comes from the chain.
    if (this.engine.isGroupIndexerDown?.()) {
      const state = this._outageFor(wallet);
      for (const message of messages) if (message.txId) state.handled.add(message.txId);
      await this._catchUpGroupsFromChain(wallet);
      if (switched()) return { controls: [], messages: [] };
    }
    this._drainChainResults(wallet, events, messages);
    return { controls: events, messages: this._takeMemberStatuses(messages, events) };
  }
}

// Group Info > Refresh Messages (iOS GroupChatService.forceRefresh): re-reads everything this
// device may see in ONE group from the beginning. Routine sync is cursor-based and never goes back
// for a message a cursor already passed (an epoch it could not decrypt then, a roster it did not
// know yet), so this drops the control cursor and this group's message cursors and walks them
// again - control first, so the roster and epoch roots are in hand before the messages decrypt.
// `onProgress` gets iOS's phases: invites, control, messages {done,total}, rebuilding.
// DSK-053: the routine sync stands down while this runs (and an in-flight pass is waited for
// first), refreshes run one at a time, and the record read for the scan list is never written
// back - the rebuilt cursors are merged onto a fresh read at the end, so a counter reserved by a
// send, or a rotation / roster change applied while the scans awaited, survives the refresh.
GroupManager.prototype.forceRefresh = function forceRefresh(groupId, onProgress = () => {}) {
  this._refreshing += 1;
  const run = this._refreshTail.then(async () => {
    // A routine pass already under way finishes first: its cursor merge must not land on top of
    // this re-walk. It never waits on a refresh (it stands down instead), so this cannot deadlock.
    if (this._syncInFlight) { try { await this._syncInFlight; } catch { /* its own problem */ } }
    return this._forceRefreshPass(groupId, onProgress);
  });
  this._refreshTail = run.then(() => {}, () => {});
  return run.finally(() => { this._refreshing -= 1; });
};

GroupManager.prototype._forceRefreshPass = async function _forceRefreshPass(groupId, onProgress) {
  const rejections = { noRootForEpoch: 0, senderNotInRoster: 0, decryptFailed: 0, epochRootsArchived: 0 };
  const archivedCount = () => Object.keys(this.getGroup(groupId)?.previousRootsHex || {}).length;
  const archivedBefore = archivedCount();
  const events = [];
  onProgress({ phase: "invites" });
  this.resetGroupControlCursor();
  try { await this._catchUpControlByRecipient(events); } catch { /* the messages are still worth a try */ }
  // By-recipient carries the admin's rotations too, so roster and epoch keys are applied by now.
  onProgress({ phase: "control" });
  // Read only for the list of streams to re-read; never written back (DSK-053).
  const record = this.getGroup(groupId);
  if (!record) return { controls: events, messages: [], rejections };
  const blindingKey = G.hexToBytes(record.blindingKeyHex);
  // Everyone ever removed too: this is the walk for finding what was missed.
  const scans = this._laneIds(record, blindingKey, { allFormer: true });
  let done = 0;
  onProgress({ phase: "messages", done, total: scans.length });
  let next = 0;
  const results = new Array(scans.length);
  await Promise.all(Array.from({ length: Math.min(4, scans.length) }, async () => {
    while (next < scans.length) {
      const i = next++;
      try { results[i] = await this.engine.scanGroupMessages(scans[i], null); }
      catch { results[i] = null; }
      done += 1;
      onProgress({ phase: "messages", done, total: scans.length });
    }
  }));
  onProgress({ phase: "rebuilding" });
  const messages = [];
  // Decode and merge in one locked, synchronous step: the rows decode with the keys of the very
  // record the cursors are written into (a root that arrived during the scans is used, not lost).
  // This pass owns this group's message cursors and nothing else: every stream was read from the
  // start, so the rebuilt set replaces the old one (a stream that failed, or a member added
  // meanwhile, has none and is read from the start by the next sweep). Every other field - the
  // counter, epoch, roots, roster, photo - stays exactly as the fresh read has it.
  await this._withGroupLock(() => {
    const cursors = {};
    const cursorTimes = {};
    this._withSeenIds(() => results.forEach((rows, i) => {
      if (!rows) return;
      for (const row of rows) {
        const parsed = G.parseGroupMessagePayload(row.payloadString);
        const decoded = this.processMessage(parsed, rejections, { txId: row.txId, blockTime: row.blockTime });
        if (decoded && decoded.groupId === groupId) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
        if (row.cursor) { cursors[scans[i]] = row.cursor; cursorTimes[scans[i]] = Number(row.blockTime) || 0; }
      }
    }));
    this._mutate(groupId, (fresh) => { fresh.cursors = cursors; fresh.cursorTimes = cursorTimes; });
  });
  rejections.epochRootsArchived = Math.max(0, archivedCount() - archivedBefore);
  return { controls: events, messages: this._takeMemberStatuses(messages, events), rejections };
};

// --- indexer outage (iOS 4f8e14bb) ---------------------------------------------------------------
// While the indexer is down, groups come from the node's block stream and from each admin's and
// member's own REST history (every gcomm and gctl is a transaction from its author to themselves).
// Rows come out as the same `{ ...decoded, txId, blockTime }` and control events syncGroups always
// returned, on the next pass. A gcomm proves its own sender (signature + roster, processMessage);
// a gctl's sender is a claim until its input's signature proves it. A txid counts once across both
// sources, and only once it has been dealt with: a row that couldn't be proven or read yet comes
// round again, from the next pass or from the indexer when it's back.
const CHAIN_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const SINCE_REWIND_MS = 10_000;
const HANDLED_LIMIT = 20_000;

GroupManager.prototype._outageFor = function _outageFor(wallet) {
  if (this._outageState?.wallet !== wallet) {
    // Another account's in-flight results die with its state object.
    this._outageState = { wallet, handled: new Set(), claimed: new Set(), lanes: new Map(), controls: [], messages: [] };
  }
  return this._outageState;
};

GroupManager.prototype._claimTx = function _claimTx(state, txId) {
  if (!txId || state.handled.has(txId) || state.claimed.has(txId)) return false;
  state.claimed.add(txId);
  return true;
};

GroupManager.prototype._releaseTx = function _releaseTx(state, txId, handled) {
  state.claimed.delete(txId);
  if (!handled) return;
  if (state.handled.size >= HANDLED_LIMIT) state.handled.clear();
  state.handled.add(txId);
};

GroupManager.prototype._drainChainResults = function _drainChainResults(wallet, events, messages) {
  const state = this._outageState;
  if (state?.wallet !== wallet) return;
  events.push(...state.controls.splice(0));
  messages.push(...state.messages.splice(0));
};

/** The block stream runs while the indexer is down; the engine ends it on an account change. */
GroupManager.prototype._refreshBlockStream = function _refreshBlockStream(wallet) {
  if (typeof this.engine.startGroupBlockScan !== "function") return;
  if (this.engine.isGroupIndexerDown?.()) {
    this.engine.startGroupBlockScan({ wallet, onRows: (rows) => this._ingestBlockRows(wallet, rows) });
    this._streamingFor = wallet;
  } else if (this._streamingFor) {
    this._streamingFor = null;
    this.engine.stopGroupBlockScan?.();
  }
};

GroupManager.prototype._ingestBlockRows = function _ingestBlockRows(wallet, rows) {
  if (this.walletAddress !== wallet) return;
  const state = this._outageFor(wallet);
  const delays = this.engine.outageProofRetryDelaysMs ?? PROOF_RETRY_DELAYS_MS;
  for (const row of rows) {
    const work = row.kind === "control"
      ? this._ingestChainControl(state, row, { delays })
      : this._ingestChainMessage(state, row);
    work.catch((error) => this.engine.log?.(`Group row from the block stream skipped: ${error?.message || error}`));
  }
};

GroupManager.prototype._ingestChainMessage = async function _ingestChainMessage(state, row) {
  if (!this._claimTx(state, row.txId)) return;
  let decoded = null;
  const refused = {};
  try {
    // In the lock like every other decode: the keys it reads are the ones the record holds now.
    await this._withGroupLock(() => {
      if (this.walletAddress !== state.wallet) return;
      decoded = this.processMessage(G.parseGroupMessagePayload(row.payloadString), refused, { txId: row.txId, blockTime: row.blockTime });
    });
    // A replay or an expired row is dealt with: no later pass reads it any differently.
  } finally { this._releaseTx(state, row.txId, Boolean(decoded) || refused.replayed > 0 || refused.expired > 0); }
  if (decoded && this.walletAddress === state.wallet) state.messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
};

/** Addressed to this wallet, or addressed to no one and readable by it. Decided before anything is
 *  asked of the REST API: most control traffic in a block is for someone else. */
GroupManager.prototype._controlIsMine = async function _controlIsMine(payloadString) {
  const parsed = G.parseControlPayload(payloadString);
  if (!parsed) return false;
  if (parsed.recipientXOnlyPubKey && G.bytesToHex(parsed.recipientXOnlyPubKey) !== this.selfPubHex()) return false;
  try { await this.engine.decryptGroupControl(parsed.encryptedHex); return true; }
  catch { return false; }
};

/** "applied" (or forged, or not ours: dealt with either way), "unknown" (can't be proven yet) or
 *  "skipped" (already claimed elsewhere). */
GroupManager.prototype._ingestChainControl = async function _ingestChainControl(state, row, { raw = null, delays = [] } = {}) {
  if (!this._claimTx(state, row.txId)) return "skipped";
  const current = () => this.walletAddress === state.wallet;
  let outcome = "applied";
  try {
    if (!row.sender) { outcome = "unknown"; return outcome; } // no claim to check: the lane has it
    if (!(await this._controlIsMine(row.payloadString))) return outcome;
    if (!current()) { outcome = "skipped"; return outcome; }
    const proof = await proofWithRetries(
      () => this.engine.provenChainSender({ txId: row.txId, expected: row.sender, raw }),
      { delays, wanted: current },
    );
    if (!current()) { outcome = "skipped"; return outcome; }
    if (proof === "unknown") { outcome = "unknown"; return outcome; }
    if (proof !== "proven") {
      this.engine.log?.(`Dropped a group control message with a forged sender: ${row.txId}`);
      return outcome;
    }
    const event = await this.applyControl(row.payloadString, row.sender, row.blockTime);
    if (!current()) { outcome = "skipped"; return outcome; }
    if (event) state.controls.push({ ...event, blockTime: row.blockTime ?? null });
    return outcome;
  } finally { this._releaseTx(state, row.txId, outcome === "applied"); }
};

/** Each admin's and member's own history, admins first: their controls hold the keys the messages
 *  need. Each address has its own cursor at the newest row seen, in memory only, so a pass asks only
 *  for what's new. Invites to groups this wallet doesn't hold yet aren't here: the stream has those. */
GroupManager.prototype._catchUpGroupsFromChain = async function _catchUpGroupsFromChain(wallet) {
  if (typeof this.engine.groupChainTransactions !== "function") return;
  const switched = () => this.walletAddress !== wallet;
  const state = this._outageFor(wallet);
  const nowMs = Date.now();
  const since = Math.max(this.sinceBlockTime > SINCE_REWIND_MS ? this.sinceBlockTime - SINCE_REWIND_MS : 0, nowMs - CHAIN_LOOKBACK_MS);
  const records = this.listGroups();
  const admins = new Set(records.map((record) => record.adminAddress).filter(Boolean));
  const members = new Set(records.flatMap((record) => [
    ...(record.members || []),
    ...(record.formerMembers || []).filter((entry) => nowMs < entry.recordedAt + FORMER_MEMBER_LANE_MS),
  ].map((member) => member.address)).filter(Boolean));
  for (const admin of admins) members.delete(admin);
  for (const address of [...admins, ...members]) {
    if (switched()) return;
    const key = String(address).toLowerCase();
    const from = Math.max(since, state.lanes.get(key) || 0);
    let history;
    try { history = await this.engine.groupChainTransactions(address, from); }
    catch { continue; } // the next pass asks again from the same place
    if (switched()) return;
    let newestSeen = from;
    for (const tx of history) {
      const found = tx.senders?.has(key) ? groupPayloadFromHex(tx.payloadHex) : null;
      if (found) {
        const row = { txId: tx.txId, sender: address, blockTime: tx.blockTime, cursor: null, payloadString: found.payloadString };
        if (found.kind === "control") {
          const outcome = await this._ingestChainControl(state, row, { raw: tx.raw });
          if (switched()) return;
          // Not listed yet, or the REST API is struggling: this address stops here so the next
          // pass starts from this row. Order matters for control.
          if (outcome === "unknown") break;
        } else {
          await this._ingestChainMessage(state, row);
          if (switched()) return;
        }
      }
      // Capped at now: one row claiming a far-future time would freeze the cursor.
      newestSeen = Math.max(newestSeen, Math.min(tx.blockTime, nowMs));
    }
    state.lanes.set(key, newestSeen);
  }
};

/** After an outage: the indexer serves everything after `toBlockTimeMs` (ms) again. The time cursor
 *  moves back. Stream cursors are the indexer's opaque tokens, which can't be set to a time, so one
 *  whose newest row is past that time (or not known) is dropped and that stream is re-read from its
 *  start: idempotent, the same re-walk a key rotation does. A stream that stopped before the time
 *  keeps its cursor. Group deletion floors are tombstones with no time in them: a deleted group has
 *  no record here to rewind, and a re-served root for it is refused by _applyRoot as always. */
GroupManager.prototype.rewindGroupCursors = async function rewindGroupCursors(toBlockTimeMs, wallet = this.walletAddress) {
  const summary = { lanes: 0, control: false, since: false };
  const to = Math.floor(Number(toBlockTimeMs));
  if (!Number.isFinite(to) || to < 0 || !wallet || wallet !== this.walletAddress) return summary;
  this._cursorRewinds += 1;
  if (this.sinceBlockTime > to) {
    this.sinceBlockTime = to;
    summary.since = true;
  }
  // A pass running now writes the time it started from back when it finishes.
  if (this._syncInFlight) this._sinceRewind = to;
  const stored = this.groupControlCursor(wallet);
  if (stored && !(Number(stored.at) > 0 && Number(stored.at) <= to)) {
    this.resetGroupControlCursor(wallet);
    summary.control = true;
  }
  await this._withGroupLock(() => {
    if (this.walletAddress !== wallet) return;
    for (const record of this.listGroups()) {
      if (this.isGroupTombstoned(record.groupId, record.adminSigningPub)) continue;
      this._mutate(record.groupId, (fresh) => {
        const cursors = { ...(fresh.cursors || {}) };
        const times = { ...(fresh.cursorTimes || {}) };
        let dropped = 0;
        for (const lane of Object.keys(cursors)) {
          const at = Number(times[lane]) || 0;
          if (at > 0 && at <= to) continue;
          delete cursors[lane];
          delete times[lane];
          dropped += 1;
        }
        if (!dropped) return false;
        summary.lanes += dropped;
        fresh.cursors = cursors;
        fresh.cursorTimes = times;
        return true;
      });
    }
  });
  return summary;
};

// --- Message retention (iOS GroupStore.applyRetentionInBackground) --------------------------------
const IN_FLIGHT_STATUSES = new Set(["draft", "building", "signing", "broadcasting", "pending"]);

/** Deletes this account's group messages older than `cutoffMs`, with their reactions and edits, the
 *  same cutoff the 1:1 sweep uses. Null ("Keep forever") deletes nothing and lifts the floor. The
 *  groups and the seen ids stay (see GROUP_SEEN_MSG_KEY). The app holds the message store in memory,
 *  so it's read and written through the app's own functions. Returns how many messages went. */
GroupManager.prototype.applyGroupRetention = function applyGroupRetention(cutoffMs, { loadMessages, saveMessages }) {
  const wallet = this.walletAddress;
  const cutoff = Number(cutoffMs) > 0 ? Number(cutoffMs) : null;
  this._retentionFloor = { wallet, cutoffMs: cutoff };
  if (!wallet || !cutoff) return 0;
  const expired = (row) => {
    if (IN_FLIGHT_STATUSES.has(String(row?.status || ""))) return false;
    const at = Number(row?.createdAt || 0);
    return Number.isFinite(at) && at > 0 && at < cutoff;
  };
  const all = loadMessages();
  const gone = new Map();
  let removed = 0;
  for (const [groupId, list] of Object.entries(all?.[wallet] || {})) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((row) => !expired(row));
    if (kept.length === list.length) continue;
    const keys = new Set();
    for (const row of list) if (expired(row)) for (const key of [row.txId, row.msgIdHex, row.id]) if (key) keys.add(key);
    gone.set(groupId, keys);
    removed += list.length - kept.length;
    all[wallet][groupId] = kept;
  }
  if (removed) saveMessages(all);
  // Keyed by what they target. A reaction has no time of its own: it goes with its message.
  const prune = (storeKey, outlives) => {
    const store = loadJsonMap(storeKey);
    let changed = false;
    for (const [groupId, targets] of Object.entries(store[wallet] || {})) {
      for (const [target, value] of Object.entries(targets || {})) {
        if (!gone.get(groupId)?.has(target) && outlives(value)) continue;
        delete targets[target];
        changed = true;
      }
    }
    if (changed) saveJsonMap(storeKey, store);
  };
  prune(GROUP_REACTIONS_KEY, () => true);
  prune(GROUP_EDITS_KEY, (edit) => !(Number(edit?.at) > 0 && Number(edit.at) < cutoff));
  return removed;
};

export function createGroupManager(engine) {
  return new GroupManager(engine);
}
