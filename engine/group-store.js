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

const GROUPS_KEY = "kachat-groups-v1";
// Per-wallet group deletion tombstones: { [wallet]: { deleted: [groupId...], published: [groupId...] } }.
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
// Marks kept per group: older epochs are dropped. Only a stale write that rolled a record back
// by more than this many rotations could get past it, and the merge-on-write rule below already
// stops stale writes; this is the backstop, not the mechanism.
const COUNTER_MARKS_KEPT = 16;
// _commitRoot's answer on the quick path when the root does need its roster resolved.
const NEEDS_ROSTER = Symbol("needs-roster");

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
    const { all, bucket } = this._bucket();
    delete bucket[groupId];
    all[this.walletAddress] = bucket;
    saveAll(all);
    this._dropCounterMarks(String(groupId));
    // Tombstone it so discovery/recovery never re-adds it, and publish an on-chain delete
    // marker (best-effort now, retried by syncGroups' backfill) so the delete survives a
    // seedless re-import too. Local intent is recorded synchronously; the chain write is async.
    this._recordTombstone(groupId, { published: false });
    Promise.resolve().then(() => this._publishTombstone(groupId)).catch(() => {});
  }

  // --- deletion tombstones ---
  _tombstoneBucket() {
    const all = loadTombstonesAll();
    const bucket = all[this.walletAddress] || { deleted: [], published: [] };
    bucket.deleted = Array.isArray(bucket.deleted) ? bucket.deleted : [];
    bucket.published = Array.isArray(bucket.published) ? bucket.published : [];
    return { all, bucket };
  }
  isGroupTombstoned(groupId) {
    return this._tombstoneBucket().bucket.deleted.includes(String(groupId));
  }
  _recordTombstone(groupId, { published }) {
    const id = String(groupId);
    const { all, bucket } = this._tombstoneBucket();
    if (!bucket.deleted.includes(id)) bucket.deleted.push(id);
    if (published && !bucket.published.includes(id)) bucket.published.push(id);
    all[this.walletAddress] = bucket;
    saveTombstonesAll(all);
  }
  _markTombstonePublished(groupId) {
    const id = String(groupId);
    const { all, bucket } = this._tombstoneBucket();
    if (!bucket.published.includes(id)) bucket.published.push(id);
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
    for (let pagesLeft = CONTROL_PAGE_BUDGET; pagesLeft > 0; pagesLeft -= 1) {
      if (this.walletAddress !== wallet) return; // switched mid-walk: the cursor is not this wallet's
      const page = await this.engine.scanGroupControlByRecipientPage(cursor, CONTROL_PAGE_LIMIT);
      if (this.walletAddress !== wallet) return;
      for (const row of page?.rows || []) {
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
      if (cursor) this._saveGroupControlCursor(wallet, { cursor, indexer, caughtUp: atEnd });
      if (atEnd) return;
    }
    // Budget spent mid-stream: the walk up to `cursor` was contiguous, so the next pass resumes
    // from it and loses nothing (already stored above, marked not caught up).
  }

  // Self-addressed, self-signed delete marker. Only our own key can produce one, and only our
  // own key can read it — see verifyTombstonePayload + the signing_pub === self check on receipt.
  async _publishTombstone(groupId) {
    const payload = G.buildSignedTombstonePayload({ groupId, signingPub: this.selfPubHex(), privateKey: this.engine.privateKeyHex });
    const encryptedHex = await this.engine.encryptGroupControl(this.walletAddress, JSON.stringify(payload));
    const wire = G.buildControlPayload({ recipientXOnlyPubKey: this.selfPubHex(), encryptedHex });
    await this.engine.sendGroupPayload(wire);
    this._markTombstonePublished(groupId);
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
    if (this.isGroupTombstoned(groupId)) return false;
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
  async _sendControlToMember(member, json, { attempts = 4, delayMs = 1800 } = {}) {
    const encryptedHex = await this.engine.encryptGroupControl(member.address, json);
    const wire = G.buildControlPayload({ recipientXOnlyPubKey: member.xOnlyPubKeyHex, encryptedHex });
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try { return await this.engine.sendGroupPayload(wire); }
      catch (error) {
        lastError = error;
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
    return this._rotateEpoch(record, "add", onProgress);
  }
  async removeMember(groupId, address) {
    const addr = String(address || "").trim();
    const record = await this._withGroupLock(() => {
      const fresh = this._requireAdmin(groupId);
      if (addr === fresh.adminAddress) throw new Error("The admin can't be removed.");
      fresh.members = fresh.members.filter((m) => m.address !== addr);
      return this._bumpEpoch(fresh);
    });
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
    if (payload.type === "gctl_root") return this._applyRoot(payload, senderAddress);
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
      const id = String(payload.group_id);
      const had = this.getGroup(id) != null;
      this._recordTombstone(id, { published: true });
      if (had) { const { all, bucket } = this._bucket(); delete bucket[id]; all[this.walletAddress] = bucket; saveAll(all); }
      this._dropCounterMarks(id);
      return had ? { kind: "deleted", groupId: id } : null;
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

  async _applyRoot(payload, senderAddress) {
    if (!G.verifyRootPayload(payload)) return null;
    const groupId = payload.group_id;
    // A tombstoned group must never be re-added — this is what makes a delete survive a
    // seedless re-import against the recovery invite.
    if (this.isGroupTombstoned(groupId)) return null;
    // A first look, only to skip the work for a root that changes nothing. The decision and the
    // write happen in _commitRoot on a record read AFTER the roster lookups below (DSK-053).
    const before = this.getGroup(groupId);
    if (before && (payload.epoch < before.currentEpoch || this._isSameRoot(before, payload))) {
      const quick = await this._withGroupLock(() => this._commitRoot(payload, senderAddress, null, null));
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
      // For an admin record the admin is ourselves; otherwise the sender is admin.
      const memberIsAdmin = isAdminRecord ? addr === this.walletAddress : addr === senderAddress;
      roster.push({ address: addr, xOnlyPubKeyHex, isAdmin: memberIsAdmin });
    }
    const result = await this._withGroupLock(() => this._commitRoot(payload, senderAddress, roster, recoveredSeedHex));
    return result === NEEDS_ROSTER ? null : result;
  }

  // Locked by the caller; synchronous. Decides on, and writes, a record read right here - after
  // the roster lookups, never before them (DSK-053): a counter reserved, a photo set or another
  // root applied while those awaited is carried into the new record instead of being dropped.
  // With `roster` null (the quick path) it only archives / skips, and returns NEEDS_ROSTER when
  // the root turns out to need applying.
  _commitRoot(payload, senderAddress, roster, recoveredSeedHex) {
    const groupId = payload.group_id;
    if (this.isGroupTombstoned(groupId)) return null;
    const existing = this.getGroup(groupId);
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
    if (this._isSameRoot(existing, payload)) return null;
    if (!roster) return NEEDS_ROSTER;
    const isAdminRecord = recoveredSeedHex != null;

    const isNewEpoch = !existing || payload.epoch > existing.currentEpoch;
    const record = {
      groupId,
      name: payload.name || existing?.name || "Group",
      isAdmin: isAdminRecord || existing?.isAdmin === true,
      adminAddress: isAdminRecord ? this.walletAddress : (senderAddress || existing?.adminAddress || null),
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
      // device_id is preserved across updates; counter resets only when the epoch advances.
      deviceIdHex: existing?.deviceIdHex || G.bytesToHex(G.generateDeviceId()),
      msgCounter: isNewEpoch ? 0 : (existing?.msgCounter || 0),
      members: roster,
      // A recovered admin group already has its recovery invite on chain for this epoch.
      selfInviteEpoch: isAdminRecord ? payload.epoch : existing?.selfInviteEpoch,
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
  processMessage(parsed, rejections = null) {
    if (!parsed) return null;
    for (const record of this.listGroups()) {
      const blindingKey = G.hexToBytes(record.blindingKeyHex);
      const expected = G.bytesToHex(G.deriveBlindedGroupId(blindingKey, parsed.senderPubKey));
      if (expected !== G.bytesToHex(parsed.blindedGroupId)) continue;
      // Sender must be in the roster (matched by pubkey).
      const member = record.members.find((m) => m.xOnlyPubKeyHex === G.bytesToHex(parsed.senderPubKey));
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

  // --- sync: pull new controls (invites/rotations) then new messages ---
  // Returns { controls: [...events], messages: [...decoded] }. The app persists
  // decoded messages into its conversation state and renders control events.
  //
  // DSK-053: the routine pass stands down while a Refresh Messages runs (that walks the same
  // streams from the start, and owns this group's cursors until it is done), and a second call
  // while a pass is in flight does not start an overlapping one. Both return an empty result with
  // `skipped` set, which the app applies as "nothing new"; the next tick syncs as usual.
  async syncGroups() {
    if (this._refreshing > 0) return { controls: [], messages: [], skipped: "refreshing" };
    if (this._syncInFlight) return { controls: [], messages: [], skipped: "in-flight" };
    const pass = this._syncGroupsPass();
    this._syncInFlight = pass;
    try { return await pass; }
    finally { if (this._syncInFlight === pass) this._syncInFlight = null; }
  }

  async _syncGroupsPass() {
    const events = [];
    // 0. Backfill recovery invites: publish a self-addressed root (with the group seed) for any
    // admin group that lacks one for its current epoch — i.e. every group created before this
    // feature existed. One-time per group per epoch; after it lands on chain, a seedless import
    // of this wallet rediscovers the group with no cloud backup. Best-effort, never blocks sync.
    for (const record of this.listGroups()) {
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
        });
        await this._sendControlToMember({ address: this.walletAddress, xOnlyPubKeyHex: this.selfPubHex() }, JSON.stringify(selfPayload));
        // The send awaited: mark it on a fresh read, never by writing `record` back (DSK-053), and
        // only if that epoch is still current (a rotation meanwhile needs its own invite).
        const epoch = record.currentEpoch;
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
      for (const id of bucket.deleted) {
        if (bucket.published.includes(id)) continue;
        try { await this._publishTombstone(id); }
        catch (error) { this.engine.log?.(`Group tombstone backfill failed: ${error?.message || error}`); }
      }
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
            const pageLatest = Number(latestBlockTime) || 0;
            latest = Math.max(latest, pageLatest);
            for (const row of rows) {
              if (!row.txId || this._sinceSeen.has(row.txId)) continue;
              this._sinceSeen.add(row.txId);
              if (this._sinceSeen.size > 4000) { for (const old of [...this._sinceSeen].slice(0, 2000)) this._sinceSeen.delete(old); }
              const parsed = G.parseGroupMessagePayload(row.payloadString);
              const decoded = this.processMessage(parsed);
              if (decoded) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
            }
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
      const scans = record.members
        .filter((member) => member.xOnlyPubKeyHex)
        .map((member) => G.bytesToHex(G.deriveBlindedGroupId(blindingKey, member.xOnlyPubKeyHex)));
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
      await this._withGroupLock(() => {
        const newest = {};
        results.forEach((rows, i) => {
          if (!rows) return;
          for (const row of rows) {
            const parsed = G.parseGroupMessagePayload(row.payloadString);
            const decoded = this.processMessage(parsed);
            if (decoded) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
            if (row.cursor) newest[scans[i]] = row.cursor;
          }
        });
        if (!Object.keys(newest).length) return;
        this._mutate(record.groupId, (fresh) => {
          const cursors = { ...(fresh.cursors || {}) };
          let changed = false;
          for (const [blindedHex, cursor] of Object.entries(newest)) {
            if ((cursors[blindedHex] || null) !== (startCursors[blindedHex] || null)) continue;
            if (cursors[blindedHex] === cursor) continue;
            cursors[blindedHex] = cursor;
            changed = true;
          }
          if (!changed) return false;
          fresh.cursors = cursors;
          return true;
        });
      });
    }
    // The first full read establishes "now"; the since reads take over from here.
    // A minute back: a computer clock running ahead must not skip the newest rows.
    if (fullScan && !this.sinceBlockTime) this.sinceBlockTime = Date.now() - 60_000;
    return { controls: events, messages };
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
  const scans = record.members
    .filter((member) => member.xOnlyPubKeyHex)
    .map((member) => G.bytesToHex(G.deriveBlindedGroupId(blindingKey, member.xOnlyPubKeyHex)));
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
    results.forEach((rows, i) => {
      if (!rows) return;
      for (const row of rows) {
        const parsed = G.parseGroupMessagePayload(row.payloadString);
        const decoded = this.processMessage(parsed, rejections);
        if (decoded && decoded.groupId === groupId) messages.push({ ...decoded, txId: row.txId, blockTime: row.blockTime });
        if (row.cursor) cursors[scans[i]] = row.cursor;
      }
    });
    this._mutate(groupId, (fresh) => { fresh.cursors = cursors; });
  });
  rejections.epochRootsArchived = Math.max(0, archivedCount() - archivedBefore);
  return { controls: events, messages, rejections };
};

export function createGroupManager(engine) {
  return new GroupManager(engine);
}
