import { confirmDialog } from "./dialogs.js";
import { IS_TESTNET } from "../engine/network.js";
import { cssUrlValue } from "./css-url.js";
import { readNextcloudAccount, writeNextcloudAccount, onKeyVaultStateChanged } from "./key-vault.js";
import { talkCallsFromCapabilities } from "./talk.js";
import { nextcloudOffReason, KASPA_QUICK_START_URL } from "./nextcloud-availability.js";
import {
  addressBookHasBackupData, addressBookHoldsWallet, addressBookWalletAddress, mergeSharedContactsFile, sharedContactsFileJson,
} from "./address-book-store.js";
import { parseBackupEnvelope } from "./backup-crypto.js";
import {
  PORTFOLIO_FILE_MAX_BYTES, isOwnPortfolioFile, isPortfolioFileCandidate, mergePortfolioSync, parsePortfolioBackupFile,
  portfolioBackupFileJson, portfolioFileNames, portfolioSyncFor,
} from "./portfolio-sync.js";
// Nextcloud integration — desktop port of the iOS stack:
// connect a server with an app password, browse it over WebDAV, send photos/videos in chats as
// public /s/TOKEN share links (rendered by the link-preview feature), and keep the account's
// contacts in sync with the server.
//
// Nextcloud backs up contacts and nothing else (iOS 4314e17e, NEXTCLOUD_SYNC.md "Contacts only"):
// messages and group chats come back from the seed, off the chain. The file is one encrypted
// `kachat-contacts.json` per folder (AES-256-GCM keyed off the identity private key, see
// ui/backup-crypto.js), holding the Address Book export. Sync is two-way: a contact changing arms a
// debounced read, merge, write, with an hourly heartbeat and a flush when the tab is hidden, and a
// change watcher polls the file's ETag with a Depth-0 PROPFIND and merges what another device wrote.
// A new device gets its contacts from that first poll. `kachat-backup.json` is retired: never read or
// written, only deleted when the user deletes their backup along with their account.
//
// One other file is outside the backup: KaPay's contacts, shared in the clear (see "Contacts shared
// with KaPay" below).
//
// Browser reality: unlike the native apps, fetches here would be subject to CORS — solved by
// routing all API traffic through vite.config.mjs's same-origin /nc-proxy passthrough (see
// apiBase()). The connect screen still detects total-failure shapes and
// tells the user to allow this origin on their server/reverse proxy. Credentials live in
// account-scoped localStorage, with the same trust model as the wallet keys: plaintext without an
// app password; with one, the Nextcloud app password is sealed with the key vault's data key
// (ui/key-vault.js readNextcloudAccount / writeNextcloudAccount) and only ever held opened in
// this page's memory while KaChat is unlocked. While locked nothing here runs (no backup, sync
// watcher, media or Talk); Settings still shows the server and login.

// Account-scoped (per wallet), which is also what makes `lastBackupEtag` per-wallet the way iOS
// scopes it by wallet hash suffix:
// { server, username, appPassword, startFolder, backupFolder, autoBackup, lastAutoBackup,
//   lastBackupEtag }   (with an app password set, appPasswordSealed
//   { v, iv, ct } is stored instead of appPassword; in memory `nc` always has the opened one)
const NC_KEY = "kachat-nextcloud-v1";
const BACKUP_FILENAME = "kachat-contacts.json";
// Where chat history used to go, and the pre-4.0 desktop-only file before that. Never read or written
// now; they stay on the server until the account is deleted (deleteRemoteNextcloudBackup).
const RETIRED_BACKUP_FILENAMES = ["kachat-backup.json", "kachat-backup-desktop.json"];
const DEFAULT_BACKUP_FOLDER = "KaChat";
// Heartbeat: a sync even when no contact changed, so a device that missed a change still catches up.
const AUTO_BACKUP_MIN_MS = 3600_000;
const AUTO_CATCHUP_MS = 86_400_000;

// --- Sync cadence (iOS NextcloudService) ------------------------------------------------
// Change watcher: how often the file's ETag is polled with a Depth-0 PROPFIND (a tiny request, no
// body download). Everything stops while the page is hidden.
const CHANGE_WATCH_MS = 30_000;
// Failed polls back off (x3 per consecutive failure, capped) and snap back on the next success.
const CHANGE_WATCH_BACKOFF_MAX_MS = 60_000;
const CHANGE_WATCH_BACKOFF_FACTOR_MAX = 12;
// Quiet time after the last contact change before the merge upload runs.
const SYNC_DEBOUNCE_MS = 15_000;
// Floor between AUTOMATIC merge uploads (the manual backup button is unaffected). A debounce firing
// earlier re-arms itself to the earliest allowed time instead of dropping the sync (the dirty flag
// stays set), so nothing is lost.
const AUTO_SYNC_MIN_MS = 90_000;

// The Portfolio (KaPay 953b255): one plain JSON file per portfolio in the backup folder. Quiet time
// after a change before the upload, and how often the server is asked for another device's changes.
const PORTFOLIO_BACKUP_DEBOUNCE_MS = 5_000;
const PORTFOLIO_SERVER_CHECK_MS = 60_000;
// The one file the Portfolio used to be kept in, newest name first. Read once, never written.
const SINGLE_PORTFOLIO_FILENAMES = ["KaPay Portfolio.json", "KaChat Wallet Portfolio.json"];

let deps = null;
let nc = null;              // null = not connected (or locked); else the account, app password opened
let ncLocked = null;        // a stored connection that cannot be used now: public fields only,
                            // { locked: true } while KaChat is locked, + unreadable when it never opens
let settingsEl = null;
let modalsEl = null;
let thumbCache = new Map(); // path -> object URL
let autoBackupTimer = null;

// --- Near-live sync state ---------------------------------------------------------------
let syncInFlight = false;       // a merge upload or merge owns the contacts
let syncDirty = false;          // a contact change is owed an upload
let syncDebounceTimer = null;
let lastAutoSyncAt = 0;
let watcherEpoch = 0;           // bumped to retire a running watcher loop
let watcherRunning = false;
let needsReconnect = false;     // Nextcloud refused this login: automatic work stops until it reconnects
let portfolioChain = null;      // one Portfolio backup at a time: two PUTs at once get 423 Locked
let portfolioDebounceTimer = null;
let lastPortfolioCheck = 0;     // when the app last looked for another device's Portfolio changes
let portfolioFileCache = new Map(); // path -> { modified, size, wallet, read }: an unchanged file isn't downloaded again

// Picker state
let pickerOpen = false;
let pickerMode = "media";   // "media" (send flow) | "folder-start" | "folder-backup"
let pickerPath = "";
let pickerStack = [];
let pickerFiles = [];
let pickerLoading = false;
let pickerError = null;
let pickerSharingPath = null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Off on testnet, and on a site KaChat hosts: there every request, the app password included,
// would pass through that site's relay (see nextcloud-availability.js). Off means exactly what
// testnet always meant here: nothing syncs, restores, uploads or rings, and every option hides as
// if disconnected.
const NC_OFF = nextcloudOffReason({ testnet: IS_TESTNET, hostname: typeof location !== "undefined" ? location.hostname : "" });

/** Why Nextcloud is off on this page ("testnet" | "hosted"), or null when it can be used. */
export function nextcloudUnavailableReason() {
  return NC_OFF;
}

function loadState() {
  // Testnet: Nextcloud is off (iOS af8ec68). The contacts file, media folder and calls are one
  // per account across both networks, so testnet could otherwise overwrite the mainnet backup or
  // bring mainnet contacts in. Nothing syncs, restores, uploads or rings; every option hides as if
  // disconnected, and the mainnet connection is waiting, untouched, for the next mainnet load.
  ncLocked = null;
  if (NC_OFF) { nc = null; return; }
  let account = null;
  try { account = readNextcloudAccount(deps.accountScopedKey(NC_KEY)); } catch { account = null; }
  // Locked (or a sealed password that does not open): nothing may run, and nothing is ever sent
  // without the real password, so `nc` stays null; Settings shows the connection from ncLocked.
  if (account && (account.locked || !account.appPassword)) { nc = null; ncLocked = account; return; }
  nc = account;
}

/** Writes the connection (the app password sealed when an app password is set). A write the
 *  vault refuses (locked, or a stale key after another tab's password change) writes nothing:
 *  logged, or thrown with `strict`. Never removes the stored connection; see clearStoredState. */
function saveState({ strict = false } = {}) {
  if (NC_OFF || !nc) return;
  try { writeNextcloudAccount(deps.accountScopedKey(NC_KEY), nc); }
  catch (error) {
    if (strict) throw error;
    deps.appendEngineLog?.(`[Nextcloud] Connection settings not saved: ${error.message}`);
  }
}

/** Disconnect: removes the stored connection (allowed while locked; nothing secret is written). */
function clearStoredState() {
  // Testnet leaves the mainnet connection untouched; on a hosted site the stored login may be
  // forgotten (the "Remove" button there).
  if (NC_OFF === "testnet") return;
  localStorage.removeItem(deps.accountScopedKey(NC_KEY));
}

/** The vault locked, unlocked or was reset: reload the connection when what can be used changed
 *  (a lock retires the opened password and stops everything; an unlock starts it as today). */
function handleVaultStateChanged() {
  if (!deps || NC_OFF) return;
  let next = null;
  try { next = readNextcloudAccount(deps.accountScopedKey(NC_KEY)); } catch { next = null; }
  const state = (account, locked) => (account ? `open\u0000${account.server}\u0000${account.username}\u0000${account.appPassword}` : locked ? `locked\u0000${locked.unreadable ? 1 : 0}` : "none");
  const usable = next && !next.locked && next.appPassword ? next : null;
  if (state(usable, usable ? null : next) === state(nc, ncLocked)) return;
  resetNextcloudForAccount();
}

function normalizedServer(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  raw = raw.replace(/\/+$/, "").replace(/\/index\.php$/i, "");
  try { const url = new URL(raw); return url.host ? raw : null; } catch { return null; }
}

function authHeader(account = nc) {
  // Never an empty or placeholder password: locked (or disconnected) means no request at all.
  if (!account?.username || !account?.appPassword) throw new Error("Nextcloud is unavailable while KaChat is locked.");
  return "Basic " + btoa(`${account.username}:${account.appPassword}`);
}

/** All API traffic goes through the dev server's same-origin /nc-proxy passthrough (see
 *  vite.config.mjs) — the browser never makes a cross-origin request, so stock Nextcloud's
 *  missing CORS headers on WebDAV/OCS no longer matter. Public /s/TOKEN share links are NOT
 *  proxied; recipients open those on the real server. */
function apiBase(server = nc?.server) {
  return `${import.meta.env.BASE_URL}nc-proxy/${encodeURIComponent(String(server || "").replace(/\/+$/, ""))}`;
}

/** fetch() for an apiBase() URL. Every relayed call names the Nextcloud it is for in
 *  x-kachat-nextcloud-origin, and the relay accepts writes (PUT/MKCOL/DELETE/POST/PROPFIND...)
 *  only to that origin (DSK-003). The origin is the server encoded into the apiBase() URL. */
function ncFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  const encoded = /nc-proxy\/([^/?#]+)/.exec(String(url))?.[1];
  try { if (encoded) headers.set("x-kachat-nextcloud-origin", new URL(decodeURIComponent(encoded)).origin); } catch { /* not a relay URL */ }
  return fetch(url, { ...init, headers });
}

function corsHint(error) {
  // With the same-origin proxy a TypeError means the dev server itself (or the network) is
  // unreachable, not CORS.
  if (error instanceof TypeError) {
    return "Could not reach the server. Check the server address and your connection, and make sure the app is running via its own dev server (npm run dev), which provides the built-in proxy.";
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** What a 429 means: KaChat's relay limiting this connection for a minute, or Nextcloud's own
 *  brute-force protection slowing sign-ins after failed attempts. */
async function tooManyRequestsText(response) {
  let relay = false;
  try { relay = (await response.clone().text()).trim() === "Too many requests"; } catch { relay = false; }
  return relay
    ? "Too many requests through KaChat's relay right now. Wait a minute and try again."
    : "Nextcloud is slowing down sign-ins from this connection after too many attempts. Wait a few minutes, check the app password, and try again.";
}

async function verifyCredentials(server, username, appPassword) {
  const response = await ncFetch(`${apiBase(server)}/ocs/v2.php/cloud/user?format=json`, {
    headers: {
      Authorization: "Basic " + btoa(`${username}:${appPassword}`),
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("Nextcloud rejected the username or app password.");
  if (response.status === 429) throw new Error(await tooManyRequestsText(response));
  if (!response.ok) throw new Error(`Nextcloud returned HTTP ${response.status}.`);
  const decoded = await response.json();
  if (!decoded?.ocs?.data) throw new Error("Unexpected response from the Nextcloud server.");
  return String(decoded.ocs.data.id || "").trim();
}

/** The user id the files paths are built on - the id Nextcloud reported at connect time, or the
 *  login as typed for connections stored before that was recorded. */
function davUser() {
  return encodeURIComponent(nc?.userId || nc?.username || "");
}
/** For an older connection that never recorded the id, ask once and keep it. */
async function ensureDavUser() {
  if (!nc || nc.userId) return;
  try {
    const id = await verifyCredentials(nc.server, nc.username, nc.appPassword);
    if (id) { nc.userId = id; saveState(); }
  } catch { /* the request that follows reports its own error */ }
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "heic", "heif", "bmp", "tiff"]);
const VIDEO_EXTENSIONS = new Set(["mov", "mp4", "m4v", "webm", "mkv", "avi"]);

function fileExtension(path) {
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function classifyEntry(entry) {
  if (entry.isDirectory) return entry;
  const type = entry.contentType || "";
  entry.isImage = type.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(entry.path));
  entry.isVideo = type.startsWith("video/") || VIDEO_EXTENSIONS.has(fileExtension(entry.path));
  return entry;
}

/** Depth-1 PROPFIND folder listing. The multistatus includes the listed folder ITSELF —
 *  excluded here at any depth (the "folder inside itself forever" bug class). */
async function listFolder(relativePath = "") {
  await ensureDavUser();
  const davBasePath = `/remote.php/dav/files/${davUser()}`;
  const listedPath = relativePath.split("/").filter(Boolean).join("/");
  const url = `${apiBase()}${davBasePath}${listedPath ? "/" + listedPath.split("/").map(encodeURIComponent).join("/") : ""}`;
  const response = await ncFetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: authHeader(),
      Depth: "1",
      "Content-Type": "application/xml",
    },
    body: `<?xml version="1.0"?>
      <d:propfind xmlns:d="DAV:">
        <d:prop><d:displayname/><d:resourcetype/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/></d:prop>
      </d:propfind>`,
    cache: "no-store",
  });
  if (response.status === 401) throw new Error(`Nextcloud refused the files path for user "${nc?.userId || nc?.username || ""}" (HTTP 401). If you signed in with an email or a different spelling of your name, disconnect and reconnect with your Nextcloud user id.`);
  if (response.status !== 207) {
    const error = new Error(response.status === 429 ? await tooManyRequestsText(response) : `Nextcloud returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
  const results = [];
  for (const responseNode of xml.getElementsByTagNameNS("DAV:", "response")) {
    const hrefNode = responseNode.getElementsByTagNameNS("DAV:", "href")[0];
    const decoded = decodeURIComponent(hrefNode?.textContent?.trim() || "");
    const baseIndex = decoded.indexOf(decodeURIComponent(davBasePath));
    if (baseIndex === -1) continue;
    const relative = decoded.slice(baseIndex + decodeURIComponent(davBasePath).length).replace(/^\/+|\/+$/g, "");
    if (!relative || relative === listedPath) continue; // the listed folder itself

    const isDirectory = responseNode.getElementsByTagNameNS("DAV:", "collection").length > 0;
    const contentType = responseNode.getElementsByTagNameNS("DAV:", "getcontenttype")[0]?.textContent || null;
    const size = Number(responseNode.getElementsByTagNameNS("DAV:", "getcontentlength")[0]?.textContent || 0) || null;
    const modifiedRaw = responseNode.getElementsByTagNameNS("DAV:", "getlastmodified")[0]?.textContent || null;
    const name = responseNode.getElementsByTagNameNS("DAV:", "displayname")[0]?.textContent
      || relative.split("/").pop();
    results.push(classifyEntry({
      path: relative,
      name,
      isDirectory,
      contentType,
      size,
      modified: modifiedRaw ? new Date(modifiedRaw) : null,
      isImage: false,
      isVideo: false,
    }));
  }
  return results;
}

/** Creates (or reuses) a public link share — shareType 3 — and returns its /s/TOKEN URL. */
async function createPublicShareLink(relativePath) {
  const endpoint = `${apiBase()}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`;
  // Read-only (permissions=1): a link to a photo or a note is for viewing, never for editing.
  const body = `path=${encodeURIComponent("/" + relativePath)}&shareType=3&permissions=1`;
  const response = await ncFetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "OCS-APIRequest": "true",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });
  if (response.status === 401) throw new Error(`Nextcloud refused the files path for user "${nc?.userId || nc?.username || ""}" (HTTP 401). If you signed in with an email or a different spelling of your name, disconnect and reconnect with your Nextcloud user id.`);
  if (response.ok) {
    const decoded = await response.json().catch(() => null);
    const url = decoded?.ocs?.data?.url;
    if (url) return url;
  }
  // Creating can fail when a link share already exists — reuse it.
  const lookup = await ncFetch(`${endpoint}&path=${encodeURIComponent("/" + relativePath)}`, {
    headers: { Authorization: authHeader(), "OCS-APIRequest": "true" },
    cache: "no-store",
  });
  if (lookup.ok) {
    const decoded = await lookup.json().catch(() => null);
    const share = (decoded?.ocs?.data || []).find((s) => s.share_type === 3 && s.url);
    if (share) return share.url;
  }
  throw new Error("Could not create a share link for that file.");
}

/** Server-side square thumbnail; returns an object URL (cached per session), or null. */
async function thumbnailURL(path) {
  if (thumbCache.has(path)) return thumbCache.get(path);
  try {
    const url = `${apiBase()}/index.php/core/preview.png?file=${encodeURIComponent("/" + path)}&x=256&y=256&a=1`;
    const response = await ncFetch(url, { headers: { Authorization: authHeader() }, cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    if (!blob.size) throw new Error("empty");
    const objectURL = URL.createObjectURL(blob);
    thumbCache.set(path, objectURL);
    return objectURL;
  } catch {
    thumbCache.set(path, null);
    return null;
  }
}

function backupFolderPath() {
  return nc?.backupFolder || DEFAULT_BACKUP_FOLDER;
}

/** Finds the KaChat folder this account already has, instead of assuming there isn't one (iOS
 *  discoverExistingBackupFolder). A folder holding the contacts file wins; a folder merely NAMED
 *  KaChat (any case, anywhere in the first few levels) is the fallback. Either way it is stored as
 *  the backup folder, so Settings names it rather than "KaChat (default)", and nothing makes a second
 *  KaChat folder beside it. A folder you picked yourself is never replaced. Breadth-first and
 *  bounded: a WebDAV walk of someone's whole drive is not a thing to do on connect. Automatic Sync
 *  stays as it is (off after connecting). */
const BACKUP_FOLDER_SCAN_VERSION = 3; // 3: looks for the contacts file; connections scanned before it get it once
const FOLDER_DISCOVERY_MAX_FOLDERS = 40;
const FOLDER_DISCOVERY_MAX_DEPTH = 3;

async function discoverExistingBackupFolder() {
  const queue = [""];
  let visited = 0;
  let namedCandidate = null;
  while (queue.length && visited < FOLDER_DISCOVERY_MAX_FOLDERS && nc) {
    const path = queue.shift();
    visited += 1;
    let entries;
    try { entries = await listFolder(path); } catch { continue; }
    // A folder holding the contacts file IS the answer - stop looking.
    if (entries.some((f) => !f.isDirectory && f.name === BACKUP_FILENAME)) {
      return path ? { path, hasBackup: true } : null;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (!namedCandidate && entry.name.toLowerCase() === DEFAULT_BACKUP_FOLDER.toLowerCase()) namedCandidate = entry.path;
      // Depth cap: a backup folder buried deeper than this is not something the app put there.
      if (entry.path.split("/").length < FOLDER_DISCOVERY_MAX_DEPTH) queue.push(entry.path);
    }
  }
  return namedCandidate ? { path: namedCandidate, hasBackup: false } : null;
}

async function adoptExistingBackupFolder() {
  if (!nc || nc.backupFolderScanned === BACKUP_FOLDER_SCAN_VERSION) return;
  if (nc.backupFolder) { nc.backupFolderScanned = BACKUP_FOLDER_SCAN_VERSION; saveState(); return; }
  const found = await discoverExistingBackupFolder();
  if (!nc) return;
  nc.backupFolderScanned = BACKUP_FOLDER_SCAN_VERSION;
  // Chosen meanwhile in the picker: that choice stands.
  if (found && !nc.backupFolder) {
    nc.backupFolder = found.path;
    delete nc.lastBackupEtag;
    saveState();
    renderSettings();
    if (found.hasBackup && !nc.autoBackup) {
      deps.showToast?.(`Found your KaChat contacts in "${found.path}". Turn on Automatic Sync to bring them in.`);
    } else if (!found.hasBackup) {
      deps.showToast?.(`Using your existing "${found.path}" folder for backups.`);
    }
  } else {
    saveState();
  }
}

// --- Media send (photos/voice upload + share link instead of on-chain bytes) ---
// There is no "Send Media via Nextcloud" setting any more (iOS 8b13460): Camera, Photo and Voice
// Message in a chat's "+" sheet ask on chain or via Nextcloud each time. A stored `mediaSend`
// from an older version is simply ignored.

async function ensureFolder(davRoot, parts) {
  let url = davRoot;
  for (const part of parts) {
    url = `${url}/${encodeURIComponent(part)}`;
    const mkcol = await ncFetch(url, { method: "MKCOL", headers: { Authorization: authHeader() } });
    if (mkcol.status === 401) throw new Error(`Nextcloud refused the files path for user "${nc?.userId || nc?.username || ""}" (HTTP 401). If you signed in with an email or a different spelling of your name, disconnect and reconnect with your Nextcloud user id.`);
    if (!mkcol.ok && mkcol.status !== 405) throw new Error(`Could not create the media folder (HTTP ${mkcol.status}).`);
  }
  return url;
}

// --- Plain files in the KaChat folder (Portfolio CSV export / import, iOS aa5d783) ---

/** Uploads `body` as `filename` into the KaChat folder (backupFolderPath - beside the contacts
 *  backup), creating the folder chain if needed, and returns the stored path. A file of the same
 *  name is replaced; exports carry a timestamp in their name, so each one is a new file.
 *  `keepSpaces` keeps a name the user gave (a portfolio's, "KaChat Contacts") readable in
 *  Nextcloud instead of turning its spaces into underscores (iOS 87b2a0b). `folder` puts it
 *  somewhere other than backupFolderPath, and `stillCurrent`,
 *  asked right before the write, stops a body built for an account that has since been switched
 *  away from. */
export async function uploadToKaChatFolder(body, filename, contentType, { keepSpaces = false, folder: folderOverride = null, stillCurrent = null } = {}) {
  if (!nc) throw new Error("Nextcloud is not connected.");
  await ensureDavUser();
  const folder = folderOverride ?? backupFolderPath();
  const parts = folder.split("/").filter(Boolean);
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const folderURL = await ensureFolder(davRoot, parts);
  const storedName = kaChatFolderFileName(filename, { keepSpaces });
  if (stillCurrent && !stillCurrent()) throw new Error("The account changed before the upload.");
  const put = await ncFetch(`${folderURL}/${encodeURIComponent(storedName)}`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": contentType || "application/octet-stream" },
    body,
  });
  if (put.status === 401) throw new Error("Nextcloud refused the upload (HTTP 401).");
  if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status}).`);
  return parts.length ? `${parts.join("/")}/${storedName}` : storedName;
}

/** The name a KaChat-folder upload is stored under: letters, digits, dot, dash and underscore
 *  survive (and spaces, with `keepSpaces` - each other character becomes "_", as iOS's
 *  sanitizedMediaFilename does); the extension always survives. */
export function kaChatFolderFileName(filename, { keepSpaces = false } = {}) {
  const name = String(filename || "file");
  const cleaned = keepSpaces
    ? name.replace(/[^\p{L}\p{N}\p{M}._\- ]/gu, "_")
    : name.replace(/[^\w.\-]+/g, "_");
  return cleaned || "file";
}

/** A file's text, for importing it. Every failure throws so the caller can say what went wrong. */
export async function downloadNextcloudText(path, { maxBytes = 10_000_000 } = {}) {
  if (!nc) throw new Error("Nextcloud is not connected.");
  await ensureDavUser();
  const encoded = String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const response = await ncFetch(`${apiBase()}/remote.php/dav/files/${davUser()}/${encoded}`, {
    headers: { Authorization: authHeader() },
    cache: "no-store",
  });
  if (response.status === 401) throw new Error("Nextcloud refused the download (HTTP 401).");
  if (!response.ok) throw Object.assign(new Error(`Download failed (HTTP ${response.status}).`), { status: response.status });
  const blob = await response.blob();
  if (blob.size > maxBytes) throw new Error("That file is too large to import.");
  return blob.text();
}

// --- Portfolio files (KaPay 953b255, its NextcloudService "Portfolio backup") ---
// Each file is encrypted with the contacts' key, in the same envelope (ui/backup-crypto.js). An
// earlier plain file of this account's is still read, and written encrypted with the next backup.

const PORTFOLIO_KEY_UNAVAILABLE_MESSAGE = "The wallet key is unavailable, so the Portfolio backup was skipped. Nothing was uploaded.";

/** What one downloaded file is (KaPay readPortfolioFile): `parsed` is the Portfolio file it holds, or
 *  null; `ownUnreadable` is this account's own envelope that won't decrypt, whose name may be written
 *  over. Another account's envelope, or one naming no account that won't decrypt, is neither. */
async function readPortfolioFile(text) {
  const plain = !parseBackupEnvelope(text);
  if (plain) return { parsed: parsePortfolioBackupFile(text), plain, ownUnreadable: false };
  try {
    return { parsed: parsePortfolioBackupFile(await deps.openBackupPayload(text)), plain, ownUnreadable: false };
  } catch (error) {
    return { parsed: null, plain, ownUnreadable: error?.code === "ownUnreadable" };
  }
}

/** Reads the backup folder: this account's Portfolio files, and the lowercased names of everything
 *  else there (another account's portfolio, or any other file), which a portfolio's file goes beside
 *  and never over. Any file that can't be downloaded throws, so nothing is written or deleted on a
 *  partial view of what's there, and so does a missing key: without it this account's files can't
 *  be told from anyone else's. */
async function readServerPortfolios(wallet) {
  if (!deps.backupKeyAvailable?.()) throw new Error(PORTFOLIO_KEY_UNAVAILABLE_MESSAGE);
  const result = { own: [], taken: new Set() };
  let listing;
  try {
    listing = await listFolder(backupFolderPath());
  } catch (error) {
    if (error?.status === 404) return result;
    throw error;
  }
  for (const file of listing) {
    if (file.isDirectory) continue;
    let read = null;
    if (isPortfolioFileCandidate(file.name, { size: file.size })) {
      const modified = file.modified ? file.modified.getTime() : null;
      const cached = portfolioFileCache.get(file.path);
      // What one account read isn't another's: the file opens with this account's key.
      if (modified != null && cached?.modified === modified && cached.size === file.size && cached.wallet === wallet) {
        read = cached.read;
      } else {
        read = await readPortfolioFile(await downloadNextcloudText(file.path, { maxBytes: PORTFOLIO_FILE_MAX_BYTES }));
        portfolioFileCache.set(file.path, { modified, size: file.size, wallet, read });
      }
    }
    if (isOwnPortfolioFile(read?.parsed, wallet)) {
      result.own.push({ file, parsed: read.parsed, plain: read.plain });
    } else if (read?.ownUnreadable) {
      // This account's, so its name stays free for this account's portfolio of that name.
      deps.appendEngineLog?.(`[Nextcloud] A Portfolio file of this account can't be decrypted: ${file.name}`);
    } else {
      result.taken.add(String(file.name).toLowerCase());
    }
  }
  return result;
}

/** Once per account: merges the one file the Portfolio used to be kept in. It stays where it is and
 *  isn't read again. A failure leaves this to run again with the next backup. */
async function mergeSinglePortfolioFileIfNeeded(account, stillCurrent) {
  if (account.singlePortfolioMerged) return false;
  try {
    let text = null;
    for (const name of SINGLE_PORTFOLIO_FILENAMES) {
      try {
        text = await downloadNextcloudText(joinedBackupPath(name), { maxBytes: PORTFOLIO_FILE_MAX_BYTES });
        break;
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    }
    if (!stillCurrent()) return false;
    const changed = text != null && deps.importPortfolioSync(parsePortfolioBackupFile(text)?.sync ?? { portfolios: [], transactions: [], fees: [], tombstones: [] });
    account.singlePortfolioMerged = true;
    saveState();
    return changed;
  } catch (error) {
    deps.appendEngineLog?.(`[Nextcloud] Merging the earlier Portfolio file failed: ${error.message}`);
    return false;
  }
}

function joinedBackupPath(name) {
  const folder = backupFolderPath();
  return folder ? `${folder}/${name}` : name;
}

/** Merges every Portfolio file of this account into this device, without uploading. */
async function mergePortfoliosFromServer(wallet, stillCurrent) {
  await mergeSinglePortfolioFileIfNeeded(nc, stillCurrent);
  const server = await readServerPortfolios(wallet);
  if (!stillCurrent()) throw new Error("The account changed during the backup.");
  if (server.own.length) deps.importPortfolioSync(mergePortfolioSync(server.own.map((found) => found.parsed.sync)));
  return server;
}

/** Back Up Portfolio Now and the automatic backup both come here, one at a time. */
export function runPortfolioBackup() {
  const previous = portfolioChain;
  const run = (async () => {
    try { await previous; } catch { /* its own caller heard about it */ }
    await performPortfolioBackup();
  })();
  portfolioChain = run;
  return run.catch((error) => { noteRejectedLogin(error); throw error; }).finally(() => { if (portfolioChain === run) portfolioChain = null; });
}

/** Uploads each portfolio to its own file, skipping one already up to date. What's on the server is
 *  merged in first, so another device's edits and deletions survive. Afterwards, this account's file
 *  for a portfolio that was deleted or renamed goes: the other files carry the deletion. */
async function performPortfolioBackup() {
  const account = nc;
  const wallet = addressBookWalletAddress();
  if (!account || !wallet) throw new Error("Open a wallet first.");
  const stillCurrent = () => nc === account && addressBookHoldsWallet(wallet);
  // Writers always encrypt: without the key nothing is uploaded readable.
  if (!deps.backupKeyAvailable?.()) throw new Error(PORTFOLIO_KEY_UNAVAILABLE_MESSAGE);
  await ensureDavUser();
  const server = await mergePortfoliosFromServer(wallet, stillCurrent);
  const sync = deps.portfolioBackupSync();
  const names = portfolioFileNames(sync.portfolios, server.taken, (name) => kaChatFolderFileName(name, { keepSpaces: true }));
  for (const portfolio of sync.portfolios) {
    const name = names.get(portfolio.id);
    const one = portfolioSyncFor(sync, portfolio.id);
    // An earlier plain file is written again, encrypted, even when its contents are the same.
    const upToDate = server.own.some((found) => String(found.file.name).toLowerCase() === name.toLowerCase() && !found.plain
      && JSON.stringify(mergePortfolioSync([found.parsed.sync])) === JSON.stringify(mergePortfolioSync([one])));
    if (upToDate) continue;
    const sealed = await deps.sealBackupPayload(portfolioBackupFileJson(one, wallet));
    await uploadToKaChatFolder(sealed, name, "application/json", { keepSpaces: true, stillCurrent });
  }
  const deletedIds = new Set(sync.tombstones.filter((t) => t.kind === "portfolio").map((t) => t.id));
  for (const found of server.own) {
    const ids = found.parsed.sync.portfolios.map((p) => p.id);
    if (ids.some((id) => names.get(id)?.toLowerCase() === String(found.file.name).toLowerCase())) continue;
    // Only for what this device knows the fate of: never a portfolio it simply doesn't have.
    if (!ids.every((id) => names.has(id) || deletedIds.has(id))) continue;
    if (!stillCurrent()) return;
    await deleteBackupFile(found.file.path);
    portfolioFileCache.delete(found.file.path);
  }
  if (stillCurrent()) { account.portfolioBackupOwed = false; saveState(); }
  deps.appendEngineLog?.("[Nextcloud] Portfolio backed up");
}

/** Deletes a file from the user's Nextcloud. 404: nothing there, which is the state asked for. */
async function deleteBackupFile(path) {
  const encoded = String(path).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const response = await ncFetch(`${apiBase()}/remote.php/dav/files/${davUser()}/${encoded}`, { method: "DELETE", headers: { Authorization: authHeader() } });
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
  if (!(response.ok || response.status === 404)) throw new Error(`Nextcloud returned HTTP ${response.status}.`);
}

/** The Portfolio changed: with Automatic Sync on, it uploads a few seconds after the changes settle. */
export function notePortfolioChanged() {
  if (!nc?.autoBackup || needsReconnect) return;
  if (!nc.portfolioBackupOwed) { nc.portfolioBackupOwed = true; saveState(); }
  schedulePortfolioBackup();
}

function schedulePortfolioBackup(delay = PORTFOLIO_BACKUP_DEBOUNCE_MS) {
  if (portfolioDebounceTimer) clearTimeout(portfolioDebounceTimer);
  const account = nc;
  portfolioDebounceTimer = window.setTimeout(() => {
    portfolioDebounceTimer = null;
    if (nc !== account || !nc?.autoBackup) return;
    runPortfolioBackup().catch((error) => deps.appendEngineLog?.(`[Nextcloud] Automatic Portfolio backup failed: ${error.message}`));
  }, delay);
}

/** With Automatic Sync on, brings in another device's Portfolio changes when the app opens, on an
 *  account activation and while the change watcher runs, at most once a minute. A change still owed
 *  is uploaded instead, which merges the server's copy in first. */
function syncPortfoliosIfDue() {
  if (!nc?.autoBackup || needsReconnect || document.visibilityState === "hidden") return;
  if (lastPortfolioCheck && Date.now() - lastPortfolioCheck < PORTFOLIO_SERVER_CHECK_MS) return;
  lastPortfolioCheck = Date.now();
  if (nc.portfolioBackupOwed) { schedulePortfolioBackup(); return; }
  const account = nc;
  const wallet = addressBookWalletAddress();
  if (!wallet) return;
  // After the other services have switched to this account.
  window.setTimeout(async () => {
    if (nc !== account) return;
    const stillCurrent = () => nc === account && addressBookHoldsWallet(wallet);
    try {
      await ensureDavUser();
      await mergePortfoliosFromServer(wallet, stillCurrent);
    } catch (error) {
      noteRejectedLogin(error);
      deps.appendEngineLog?.(`[Nextcloud] Checking the Portfolio on the server failed: ${error.message}`);
    }
  }, 1000);
}

/** A 401 won't fix itself, and repeated failed logins can trip the server's brute-force protection:
 *  automatic work stops and Settings asks for a new connection (KaPay 953b255 needsReconnect). */
function noteRejectedLogin(error) {
  if (needsReconnect || !/HTTP 401|rejected the (stored app password|username)/.test(String(error?.message || ""))) return;
  needsReconnect = true;
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  if (portfolioDebounceTimer) { clearTimeout(portfolioDebounceTimer); portfolioDebounceTimer = null; }
  stopChangeWatcher();
  deps.appendEngineLog?.("[Nextcloud] The server refused this login; automatic sync stops until it reconnects");
  renderSettings();
}

/** Revokes the app password on the server, so disconnecting leaves nothing that can still log in.
 *  Best effort: the local copy is gone whatever the server says (KaPay 953b255). */
export async function revokeAppPassword(account) {
  if (!account?.server || !account?.appPassword) return;
  try {
    const response = await ncFetch(`${apiBase(account.server)}/ocs/v2.php/core/apppassword`, {
      method: "DELETE",
      headers: { Authorization: authHeader(account), "OCS-APIRequest": "true" },
    });
    deps.appendEngineLog?.(`[Nextcloud] App password revoke answered HTTP ${response.status}`);
  } catch (error) {
    deps.appendEngineLog?.(`[Nextcloud] App password revoke failed: ${error.message}`);
  }
}

let pickerAllowedExtensions = null;
/** Browses the account and hands back the file picked - no share link. Starts in the KaChat
 *  folder (where Export to Nextcloud puts files) with All Files for the root; only files whose
 *  extension is allowed can be picked, the rest show dimmed (iOS NextcloudFileSelectView). */
export function openNextcloudFilePicker({ allowedExtensions = [], onPicked = null } = {}) {
  if (!nc) { deps.showToast?.("Connect Nextcloud in Settings → Storage first."); return false; }
  pickerAllowedExtensions = new Set(allowedExtensions.map((ext) => String(ext).toLowerCase()));
  pickerOnPicked = onPicked;
  openPicker("file");
  return true;
}

/** Uploads media bytes to KaChat/Media/ and returns the public /s/TOKEN share link. */
export async function uploadNextcloudMedia(blob, filename, contentType) {
  if (!nc) throw new Error("Nextcloud is not connected.");
  const safeName = String(filename || "file").replace(/[^\w.\-]+/g, "_");
  const unique = `${Math.random().toString(36).slice(2, 10)}_${safeName}`;
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const folderURL = await ensureFolder(davRoot, ["KaChat", "Media"]);
  const put = await ncFetch(`${folderURL}/${encodeURIComponent(unique)}`, {
    method: "PUT",
    headers: { Authorization: authHeader(), "Content-Type": contentType || "application/octet-stream" },
    body: blob,
  });
  if (!put.ok) throw new Error(`Media upload failed (HTTP ${put.status}).`);
  return createPublicShareLink(`KaChat/Media/${unique}`);
}

/** Uploads the merged archive. Returns the uploaded file's ETag when the server sent one on the
 *  PUT response (`OC-ETag` first — Nextcloud's canonical header — then `ETag`), normalized;
 *  null when the header is missing (some proxies strip it; runBackup then recovers it with a
 *  follow-up PROPFIND). */
// The temp copy an upload writes before it is renamed over the backup (DSK-049).
const UPLOAD_TEMP_PREFIX = `.${BACKUP_FILENAME}.upload-`;
const UPLOAD_DEVICE_KEY = "kachat-nextcloud-upload-id";
const STALE_UPLOAD_MS = 60 * 60 * 1000;
function uploadDeviceId() {
  try {
    let id = localStorage.getItem(UPLOAD_DEVICE_KEY) || "";
    if (!/^[a-z0-9]{8,16}$/.test(id)) {
      id = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
      localStorage.setItem(UPLOAD_DEVICE_KEY, id);
    }
    return id;
  } catch { return "device"; }
}
/** Removes upload copies older than an hour from the backup folder - never this upload's own. */
async function clearStaleUploadCopies(ownTempName) {
  const listing = await listFolder(backupFolderPath());
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const folder = backupFolderPath().split("/").map(encodeURIComponent).join("/");
  for (const entry of listing) {
    if (entry.isDirectory || !String(entry.name || "").startsWith(UPLOAD_TEMP_PREFIX) || entry.name === ownTempName) continue;
    const modified = entry.modified instanceof Date ? entry.modified.getTime() : 0;
    if (modified && Date.now() - modified < STALE_UPLOAD_MS) continue; // maybe another device's upload in flight
    await ncFetch(`${davRoot}/${folder}/${encodeURIComponent(entry.name)}`, { method: "DELETE", headers: { Authorization: authHeader() } }).catch(() => {});
  }
}

async function uploadBackup(payloadJson) {
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const folderURL = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}`;
  const mkcol = await ncFetch(folderURL, { method: "MKCOL", headers: { Authorization: authHeader() } });
  if (mkcol.status === 401) throw new Error(`Nextcloud refused the files path for user "${nc?.userId || nc?.username || ""}" (HTTP 401). If you signed in with an email or a different spelling of your name, disconnect and reconnect with your Nextcloud user id.`);
  if (!mkcol.ok && mkcol.status !== 405) throw new Error(`Could not create the backup folder (HTTP ${mkcol.status}).`);

  // The file is written to a temporary file first and then renamed over the backup (WebDAV
  // MOVE), the way sync clients do it. Nextcloud write-locks a file for as long as a PUT into it
  // runs, and an upload cut off halfway (a tab closed during its final flush, a dropped
  // connection) left that lock on the backup itself until the server expired it - every later
  // read and write answered 423 Locked meanwhile. Now only the temporary file is ever mid-upload;
  // the backup is locked just for the instant of the rename.
  // One temp name per device (DSK-049): an upload cut off before its rename is overwritten by the
  // next one instead of leaving another full-size hidden copy, and old ones are cleared below.
  const tempName = `${UPLOAD_TEMP_PREFIX}${uploadDeviceId()}`;
  const tempURL = `${folderURL}/${encodeURIComponent(tempName)}`;
  const dropTemp = () => ncFetch(tempURL, { method: "DELETE", headers: { Authorization: authHeader() } }).catch(() => {});
  let put;
  try {
    put = await ncFetch(tempURL, {
      method: "PUT",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: payloadJson,
    });
  } catch (error) {
    await dropTemp();
    throw error;
  }
  if (put.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
  if (!put.ok) { await dropTemp(); throw new Error(`Backup upload failed (HTTP ${put.status}).`); }
  // MOVE names its target by absolute URL, and Nextcloud only accepts its own: the real server
  // address, not the relay's.
  const realFolder = `${String(nc?.server || "").replace(/\/+$/, "")}/remote.php/dav/files/${davUser()}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}`;
  // A rename onto a file another device is writing right now still meets its lock: waited out
  // on a short backoff, half a minute in all, and only a lock that never clears surfaces.
  for (let attempt = 0; ; attempt += 1) {
    const move = await ncFetch(tempURL, {
      method: "MOVE",
      headers: { Authorization: authHeader(), Destination: `${realFolder}/${encodeURIComponent(BACKUP_FILENAME)}`, Overwrite: "T" },
    });
    if (move.status === 423) {
      if (attempt >= LOCK_RETRY_DELAYS_S.length) {
        await dropTemp();
        throw new Error("Nextcloud has the backup file locked (HTTP 423): another device or sync is writing it right now, or an earlier upload was cut off and the server still holds its lock (it lets go on its own, usually within the hour). Try again later.");
      }
      deps.appendEngineLog?.(`Nextcloud backup file locked (HTTP 423), retrying in ${LOCK_RETRY_DELAYS_S[attempt]}s`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAYS_S[attempt] * 1000));
      continue;
    }
    if (!move.ok) {
      // A server (or something in front of it) that will not rename: write the backup directly,
      // as before, rather than not at all.
      await dropTemp();
      deps.appendEngineLog?.(`Nextcloud refused the rename (HTTP ${move.status}); uploading the backup directly.`);
      const direct = await ncFetch(`${folderURL}/${BACKUP_FILENAME}`, {
        method: "PUT",
        headers: { Authorization: authHeader(), "Content-Type": "application/json" },
        body: payloadJson,
      });
      if (direct.status === 423) throw new Error("Nextcloud has the backup file locked (HTTP 423): another device or sync is writing it right now. Try again later.");
      if (!direct.ok) throw new Error(`Backup upload failed (HTTP ${direct.status}).`);
      const directTag = direct.headers.get("OC-ETag") || direct.headers.get("ETag");
      return directTag ? normalizeETag(directTag) || null : null;
    }
    // In place: clear upload copies another device (or an older build's random names) left
    // behind when an upload was cut off (DSK-049). Best effort, never in the way of the backup.
    clearStaleUploadCopies(tempName).catch(() => {});
    const raw = move.headers.get("OC-ETag") || move.headers.get("ETag");
    const normalized = raw ? normalizeETag(raw) : "";
    if (normalized) return normalized;
    // Not every server sends the ETag on a MOVE: ask for it, so the change watcher knows this
    // upload is ours.
    try { return await fetchBackupETag(); } catch { return null; }
  }
}
const LOCK_RETRY_DELAYS_S = [1, 2, 4, 8, 15];

// Backups on this device queue behind each other: Back Up Contacts Now must not run into the automatic
// sync's upload of the same file (iOS 6551904).
let backupChain = Promise.resolve();
/** Exported for tools/test-nextcloud-shared-contacts.mjs. */
export function runBackup() {
  const run = backupChain.then(() => performBackup(), () => performBackup());
  backupChain = run.then(() => {}, () => {});
  return run;
}

// One sync = read, merge, write, verify (NEXTCLOUD_SYNC.md "Contacts only"). The newest edit or
// deletion wins per address, so no device can undo another's newer change, and the file is written
// only when it is missing something this device has. It goes to one hidden temp copy per device and
// is renamed over the file (uploadBackup), so a cut-off upload never locks or damages it. What happens
// to the server copy:
// - a download that failed or stopped early (a transfer problem) throws before any write;
// - a plain file, another wallet's file, a hint-less envelope that won't open, or one that opens and
//   isn't an Address Book throws - never touched;
// - THIS wallet's envelope that fails to decrypt is replaced in place. Nextcloud's own version history
//   keeps its earlier contents.
async function performBackup() {
  const account = nc;
  const wallet = addressBookWalletAddress();
  if (!account || !wallet) throw new Error("Open a wallet first.");
  const stillCurrent = () => nc === account && addressBookHoldsWallet(wallet);
  if (!stillCurrent()) throw new Error("The account changed during the backup.");
  const raw = await downloadBackupFile(BACKUP_FILENAME);
  let serverCopy = null;
  let replaceUnreadable = false;
  if (raw != null) {
    if (!parseBackupEnvelope(raw)) throw new Error("The contacts file on the server isn't encrypted by KaChat, so it was left alone.");
    try {
      serverCopy = await deps.openBackupPayload(raw);
    } catch (error) {
      if (error?.code !== "ownUnreadable") throw error;
      deps.appendEngineLog?.("[Nextcloud] This account's contacts file can't be decrypted; replacing it in place");
      replaceUnreadable = true;
    }
  }
  if (!stillCurrent()) throw new Error("The account changed during the backup.");
  let serverIsBehind = replaceUnreadable || addressBookHasBackupData();
  if (serverCopy != null) serverIsBehind = mergeSharedContactsFile(serverCopy).serverIsBehind;
  if (!serverIsBehind) {
    rememberBackupETag(await fetchBackupETag().catch(() => null));
    return;
  }
  const payload = await deps.sealBackupPayload(sharedContactsFileJson());
  if (!stillCurrent()) throw new Error("The account changed during the backup.");
  let newETag = await uploadBackup(payload);
  if (!newETag) {
    // Some proxies strip the PUT response's ETag header; one follow-up Depth-0 PROPFIND
    // recovers it so the change watcher still recognises this device's own write.
    newETag = await fetchBackupETag().catch(() => null);
  }
  // Feedback-loop guard: remember our own write's ETag so the watcher never downloads it back.
  // If both captures failed the stored ETag is cleared, and the watcher merges our own upload once,
  // which changes nothing.
  rememberBackupETag(newETag);
  // Verify (§4.6): the server must hold the whole file. A short one (an upload cut off on the
  // way) would read as damaged on the next sync; say so plainly instead of looping. Only our own
  // write counts: another device may have replaced the file in between.
  const expectedBytes = new TextEncoder().encode(payload).length;
  const stored = await fetchBackupInfo();
  const storedBytes = Number(stored?.size || 0);
  if (stored && storedBytes && storedBytes !== expectedBytes) {
    const currentETag = await fetchBackupETag().catch(() => null);
    if (!newETag || currentETag === newETag) {
      deps.appendEngineLog?.(`Nextcloud stored ${storedBytes} of ${expectedBytes} backup bytes - the upload was cut off.`);
      throw transientError(`The backup upload was cut off: the server stored ${storedBytes.toLocaleString()} of ${expectedBytes.toLocaleString()} bytes. Something between this device and Nextcloud is ending uploads early.`);
    }
  }
}

async function fetchBackupInfo() {
  try {
    const listing = await listFolder(backupFolderPath());
    return listing.find((f) => !f.isDirectory && f.name === BACKUP_FILENAME) || null;
  } catch { return null; }
}

/** A failure the caller should RETRY rather than report as a bad file: a captive portal, a
 *  reverse-proxy error page, a maintenance screen, a truncated body. Marked so the change
 *  watcher backs off. */
function transientError(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

/** Downloads one backup file from the configured folder; null when it doesn't exist (404).
 *
 *  A WebDAV GET of the backup file is NEVER legitimately HTML: a 2xx HTML body is a
 *  reverse-proxy, sign-in, captive-portal or maintenance page standing in for the server, and
 *  must not read as a foreign file. Mirrors iOS NextcloudService.downloadBackup's mimeType guard
 *  and its empty-body check. */
async function downloadBackupFile(filename) {
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const url = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(filename)}`;
  const response = await ncFetch(url, { headers: { Authorization: authHeader() }, cache: "no-store" });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
  // Locked while another device writes it: not a failure, the next attempt reads it.
  if (response.status === 423) throw transientError("Nextcloud has the backup file locked right now (HTTP 423): another device is writing it. Trying again shortly.");
  if (!response.ok) throw new Error(`Backup download failed (HTTP ${response.status}).`);
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const text = await response.text();
  if (contentType.includes("html") || /^\s*(<!doctype html|<html[\s>])/i.test(text)) {
    throw transientError("The server sent a web page instead of the backup file (a sign-in, proxy or maintenance page). The backup was left untouched.");
  }
  // A 2xx with nothing in it is a truncated/proxied response, not an empty file.
  if (!text.trim()) {
    throw transientError("The server returned an empty response for the backup file. The backup was left untouched.");
  }
  // A short file must never read as a damaged one and be overwritten. One JSON object must start
  // with { and end with }; a truncated body cannot end with }, whatever compression it arrived under.
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw transientError(
      `The backup file arrived incomplete (${text.length.toLocaleString()} characters, ending mid-file). `
      + "Nothing on the server was changed, so trying again is safe."
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// ETag helpers (change detection + own-write feedback guard)
// ---------------------------------------------------------------------------

/** Strips the weak-validator prefix and surrounding quotes so a PUT response header ETag and a
 *  PROPFIND getetag for the same content compare equal. Mirrors iOS `normalizedETag`. */
function normalizeETag(raw) {
  let value = String(raw || "").trim();
  if (/^W\//i.test(value)) value = value.slice(2).trim();
  return value.replace(/^"+|"+$/g, "").trim();
}

/** Pulls the getetag value out of a Depth-0 multistatus. DOMParser first (namespace-correct
 *  whatever prefix the server uses), regex as a fallback for servers whose XML the parser
 *  rejects. Mirrors iOS `parseETagFromMultistatus`. */
function parseETagFromMultistatus(xmlText) {
  try {
    const xml = new DOMParser().parseFromString(xmlText, "application/xml");
    const node = xml.getElementsByTagNameNS("DAV:", "getetag")[0];
    const value = normalizeETag(node?.textContent || "");
    if (value) return value;
  } catch { /* fall through to the regex */ }
  const match = String(xmlText || "").match(/<[^<>]*getetag[^<>]*>([^<]+)<\/[^<>]*getetag[^<>]*>/i);
  if (!match) return null;
  const decoded = match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
  return normalizeETag(decoded) || null;
}

/** The backup file's current ETag via a Depth-0 PROPFIND requesting only `getetag` — a tiny
 *  request with no body download.
 *  null = no backup file yet (404); throws on any other failure. */
async function fetchBackupETag() {
  if (!nc) return null;
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const url = `${davRoot}/${backupFolderPath().split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(BACKUP_FILENAME)}`;
  const response = await ncFetch(url, {
    method: "PROPFIND",
    headers: { Authorization: authHeader(), Depth: "0", "Content-Type": "application/xml" },
    body: `<?xml version="1.0"?>\n<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`,
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
  if (response.status !== 207) throw new Error(response.status === 429 ? await tooManyRequestsText(response) : `Nextcloud returned HTTP ${response.status}.`);
  const etag = parseETagFromMultistatus(await response.text());
  if (!etag) throw transientError("The server's file listing did not include an ETag.");
  return etag;
}

/** Persists the last ETag this device wrote or imported. `nc` is already account-scoped
 *  (accountScopedKey), so this is per-wallet the same way iOS scopes `lastETagKey`. */
function rememberBackupETag(etag) {
  if (!nc) return;
  if (etag) nc.lastBackupEtag = etag;
  else delete nc.lastBackupEtag;
  saveState();
}

// ---------------------------------------------------------------------------
// Automatic sync
//
// Upload side: a contact changing arms a debounced merge upload (15s of quiet), floored at one
// automatic upload per 90s, plus an hourly heartbeat and a flush when the tab is hidden.
// Download side: the change watcher below polls the file's ETag and merges what another device wrote.
// ---------------------------------------------------------------------------

function armSyncDebounce(delayMs) {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = window.setTimeout(() => {
    syncDebounceTimer = null;
    performAutomaticSync();
  }, Math.max(0, delayMs));
}

/**
 * The one automatic upload path. The dirty flag is cleared BEFORE the upload — a change
 * arriving during it re-marks the flag, so nothing is lost — and re-marked on any failure so a
 * later trigger retries. `bypassFloor` is used only by the tab-hide flush, which is the desktop
 * "leaving" moment and may be the last chance to write.
 */
async function performAutomaticSync({ bypassFloor = false } = {}) {
  if (!nc?.autoBackup || needsReconnect) return;
  if (syncInFlight) {
    // Something else owns the contacts; the dirty flag stays set and a short re-arm retries.
    armSyncDebounce(30_000);
    return;
  }
  if (!bypassFloor && lastAutoSyncAt) {
    const elapsed = Date.now() - lastAutoSyncAt;
    if (elapsed < AUTO_SYNC_MIN_MS) {
      // Re-arm to the earliest allowed moment instead of dropping the sync.
      armSyncDebounce(AUTO_SYNC_MIN_MS - elapsed);
      return;
    }
  }
  syncInFlight = true;
  syncDirty = false;
  try {
    await runBackup();
    lastAutoSyncAt = Date.now();
    if (nc) { nc.lastAutoBackup = lastAutoSyncAt; saveState(); }
    refreshBackupStatusLine();
  } catch (error) {
    syncDirty = true;
    deps.appendEngineLog?.(`Nextcloud automatic sync upload failed (a later trigger retries): ${error.message}`);
    noteRejectedLogin(error);
  } finally {
    syncInFlight = false;
  }
}

async function autoBackupIfDue(minMs = AUTO_BACKUP_MIN_MS) {
  if (!nc?.autoBackup || needsReconnect) return;
  const last = Number(nc.lastAutoBackup || 0);
  const due = Date.now() - last >= minMs;
  if (!due && !syncDirty) return;
  await performAutomaticSync();
}

/** A contact changed (iOS noteContactActivity): marks the contacts dirty and restarts the quiet-time
 *  timer, so a run of edits becomes one merge upload. Cheap and safe to call at any rate. */
export function noteContactActivity() {
  if (!nc?.autoBackup || needsReconnect) return;
  syncDirty = true;
  armSyncDebounce(SYNC_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Change watcher — the pull of another device's contact changes
//
// Polls the file's ETag with a Depth-0 PROPFIND. When it differs from the last ETag this device wrote
// or merged, the file is downloaded, decrypted and merged into the contacts silently, with one
// engine-log line. Mirrors iOS NextcloudService.startChangeWatcherIfNeeded / runChangeWatcher.
// ---------------------------------------------------------------------------

function startChangeWatcherIfNeeded() {
  if (watcherRunning) return;
  if (!nc?.autoBackup) return;
  if (document.visibilityState === "hidden") return;
  watcherEpoch += 1;
  watcherRunning = true;
  const epoch = watcherEpoch;
  runChangeWatcher(epoch).finally(() => { if (watcherEpoch === epoch) watcherRunning = false; });
}

/** Stops the watcher: on tab-hide, disconnect, wallet switch and toggle-off. The epoch bump
 *  keeps a mid-await loop iteration from outliving the stop. */
function stopChangeWatcher() {
  watcherEpoch += 1;
  watcherRunning = false;
}

async function runChangeWatcher(epoch) {
  let backoffFactor = 1;
  while (watcherEpoch === epoch) {
    const interval = Math.min(CHANGE_WATCH_MS * backoffFactor, CHANGE_WATCH_BACKOFF_MAX_MS);
    await sleepInterruptibly(interval, epoch);
    if (watcherEpoch !== epoch) break;
    if (!nc?.autoBackup || document.visibilityState === "hidden") break;
    try {
      await checkForRemoteChangeAndImport();
      syncPortfoliosIfDue();
      backoffFactor = 1;
    } catch (error) {
      backoffFactor = Math.min(backoffFactor * 3, CHANGE_WATCH_BACKOFF_FACTOR_MAX);
      deps.appendEngineLog?.(`Nextcloud change watcher poll failed (backing off): ${error.message}`);
      noteRejectedLogin(error);
    }
  }
}

/** Sleeps up to `ms` in short slices, returning early when the watcher is retired (epoch bump). */
async function sleepInterruptibly(ms, epoch) {
  const deadline = Date.now() + ms;
  while (watcherEpoch === epoch) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) => window.setTimeout(resolve, Math.min(250, remaining)));
  }
}

/** One poll: fetch the ETag, and merge the file if it changed. Exported for
 *  tools/test-nextcloud-shared-contacts.mjs. */
export async function checkForRemoteChangeAndImport() {
  const account = nc;
  const wallet = addressBookWalletAddress();
  if (!account || !wallet) return;
  const stillCurrent = () => nc === account && addressBookHoldsWallet(wallet);
  // ETag BEFORE the download: if the file is replaced between the two requests the stored ETag
  // is the older one and the next poll simply merges again — the safe direction, since a merge
  // changes nothing the second time.
  const etag = await fetchBackupETag();
  if (!etag) return;                      // no file on the server yet
  if (etag === nc?.lastBackupEtag) return; // our own write, or already merged
  if (syncInFlight || !stillCurrent()) return; // retry on the next poll, ETag left alone

  syncInFlight = true;
  try {
    const raw = await downloadBackupFile(BACKUP_FILENAME);
    if (!raw || !stillCurrent()) return;  // vanished between the poll and the download
    let serverIsBehind = false;
    try {
      if (!parseBackupEnvelope(raw)) throw new Error("It isn't encrypted by KaChat.");
      const plain = await deps.openBackupPayload(raw);
      if (!stillCurrent()) return;
      serverIsBehind = mergeSharedContactsFile(plain).serverIsBehind;
    } catch (error) {
      // A file this wallet can't read: record the ETag so it is not downloaded every poll. A future
      // replacement changes the ETag and gets a fresh look.
      rememberBackupETag(etag);
      deps.appendEngineLog?.(`Nextcloud change watcher skipped an unreadable contacts file: ${error.message}`);
      return;
    }
    rememberBackupETag(etag);
    // This device may hold a contact the file never had. It ends rather than ping-pongs: the next
    // device's merge of that upload finds nothing to add, so it uploads nothing.
    if (serverIsBehind) noteContactActivity();
    deps.appendEngineLog?.("Nextcloud change watcher merged another device's contacts.");
  } finally {
    syncInFlight = false;
  }
}

/** Arms (or disarms) everything automatic: the hourly heartbeat and the change watcher. */
function armAutoBackup() {
  if (autoBackupTimer) { clearInterval(autoBackupTimer); autoBackupTimer = null; }
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  stopChangeWatcher();
  if (!nc?.autoBackup) return;
  autoBackupTimer = window.setInterval(() => autoBackupIfDue(), AUTO_BACKUP_MIN_MS);
  autoBackupIfDue(AUTO_CATCHUP_MS);
  startChangeWatcherIfNeeded();
  syncPortfoliosIfDue();
}

function ncConnectFormValid() {
  const server = String(settingsEl?.querySelector("[data-nc-server]")?.value || "").trim();
  const username = String(settingsEl?.querySelector("[data-nc-username]")?.value || "").trim();
  const password = String(settingsEl?.querySelector("[data-nc-password]")?.value || "").trim();
  return Boolean(server && username && password);
}
function refreshConnectFormState() {
  if (!settingsEl || nc) return;
  const server = String(settingsEl.querySelector("[data-nc-server]")?.value || "").trim().toLowerCase();
  const httpsError = settingsEl.querySelector("[data-nc-https-error]");
  if (httpsError) httpsError.hidden = !server.startsWith("http://");
  const button = settingsEl.querySelector("[data-nc-connect]");
  if (button && button.textContent !== "Connecting…") button.disabled = !ncConnectFormValid();
}

function renderSettings() {
  if (!settingsEl) return;
  if (NC_OFF === "hosted") {
    // A login saved here before Nextcloud moved to self-run copies is never used again; it can be
    // removed from this browser.
    const stored = Boolean(localStorage.getItem(deps.accountScopedKey(NC_KEY)));
    settingsEl.innerHTML = `
      <div class="settings-list-card nc-hosted-off">
        <div class="settings-page-form">
          <strong>Nextcloud works when you run KaChat and Nextcloud with <a href="${KASPA_QUICK_START_URL}" target="_blank" rel="noopener noreferrer">Kaspa Quick Start</a>.</strong>
          <p class="nc-hosted-copy">On this website your Nextcloud login would pass through the website's server. To keep it between you and your Nextcloud, install <a href="${KASPA_QUICK_START_URL}" target="_blank" rel="noopener noreferrer">Kaspa Quick Start</a>, switch on KaChat-Desktop and Nextcloud in its control panel, and open KaChat from the address it gives you (like http://localhost:5173). Nextcloud is available there.</p>
        </div>
        <a class="settings-list-row" href="${KASPA_QUICK_START_URL}" target="_blank" rel="noopener noreferrer" data-nc-quick-start>
          <span class="settings-row-copy"><strong>Get Kaspa Quick Start</strong></span>
          <svg class="settings-dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </a>
      </div>
      <p class="settings-group-footer">Backups, sync, media and calls through Nextcloud are off on this website. Files friends share with you still open, straight from their Nextcloud.</p>
      ${stored ? `<div class="settings-list-card danger-list-card">
        <button class="settings-list-row danger-row" type="button" data-nc-forget-hosted><span class="settings-row-copy"><strong>Remove Saved Nextcloud Login</strong></span></button>
      </div>
      <p class="settings-group-footer">A Nextcloud login saved in this browser earlier is no longer used. Removing it deletes it from this browser. Nothing changes on your Nextcloud server.</p>` : ""}`;
    settingsEl.querySelector("[data-nc-forget-hosted]")?.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: "Remove Saved Login", message: "The Nextcloud login saved in this browser is deleted. Nothing changes on your Nextcloud server.", confirmLabel: "Remove", destructive: true });
      if (!ok) return;
      clearStoredState();
      renderSettings();
    });
    updateComposerButton();
    return;
  }
  if (NC_OFF === "testnet") {
    settingsEl.innerHTML = `
      <div class="settings-list-card nc-testnet-off">
        <div class="settings-page-form"><strong>Nextcloud is off while Testnet is on.</strong></div>
      </div>`;
    updateComposerButton();
    return;
  }
  if (!nc && ncLocked) {
    // A stored connection whose app password is sealed and not open: say where it is connected,
    // run nothing. Unlocking KaChat reloads it (handleVaultStateChanged).
    const lockedHost = (() => { try { return new URL(ncLocked.server).host; } catch { return ncLocked.server; } })();
    const note = ncLocked.unreadable
      ? "The stored app password could not be decrypted on this device. Disconnect, then connect again with an app password."
      : "Your Nextcloud app password is encrypted with your KaChat password. Backup, sync, media and calls through Nextcloud start once KaChat is unlocked.";
    settingsEl.innerHTML = `
      <p class="settings-group-label">Connected Account</p>
      <div class="settings-list-card">
        <div class="settings-list-row settings-info-row"><span class="settings-row-copy"><strong>Server</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(lockedHost)}</span></div>
        <div class="settings-list-row settings-info-row"><span class="settings-row-copy"><strong>Username</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(ncLocked.username)}</span></div>
      </div>
      <p class="settings-group-footer" data-nc-locked-note>Connected to ${deps.escapeHtml(lockedHost)} as ${deps.escapeHtml(ncLocked.username)}. ${deps.escapeHtml(note)}</p>
      <div class="settings-list-card danger-list-card">
        <button class="settings-list-row danger-row" type="button" data-nc-disconnect><span class="settings-row-copy"><strong>Disconnect</strong></span></button>
      </div>`;
    updateComposerButton();
    return;
  }
  if (!nc) {
    settingsEl.innerHTML = `
      <p class="settings-group-label">Server</p>
      <div class="settings-list-card nc-connect-card">
        <label class="field-label">Server<input class="field-input" type="text" data-nc-server placeholder="cloud.example.com" autocomplete="off" spellcheck="false" /></label>
        <p class="field-error" data-nc-https-error hidden>Use https. Unencrypted connections are not supported.</p>
        <label class="field-label">Username<input class="field-input" type="text" data-nc-username autocomplete="off" spellcheck="false" /></label>
        <label class="field-label">App password<span class="password-field-wrap"><input class="field-input" type="password" data-nc-password autocomplete="off" /><button class="password-eye-btn" type="button" data-eye-toggle aria-label="Show password"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.3 12.3C4.4 7.7 8 5.2 12 5.2s7.6 2.5 9.7 7.1a.9.9 0 0 1 0 .8c-2.1 4.6-5.7 7.1-9.7 7.1s-7.6-2.5-9.7-7.1a.9.9 0 0 1 0-.8Z"/><circle cx="12" cy="12.7" r="3.1"/></svg></button></span></label>
        <p class="field-error" data-nc-connect-error hidden></p>
        <button class="primary-button full" type="button" data-nc-connect disabled>Connect</button>
      </div>`;
    updateComposerButton();
    return;
  }

  const host = (() => { try { return new URL(nc.server).host; } catch { return nc.server; } })();
  const lastSynced = Number(nc.lastAutoBackup || 0);
  settingsEl.innerHTML = `
    <p class="settings-group-label">Connected Account</p>
    <div class="settings-list-card">
      <div class="settings-list-row settings-info-row"><span class="settings-row-copy"><strong>Server</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(host)}</span></div>
      <div class="settings-list-row settings-info-row"><span class="settings-row-copy"><strong>Username</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(nc.username)}</span></div>
    </div>
    <div class="settings-list-card">
      <button class="settings-list-row" type="button" data-nc-pick-start><span class="settings-row-copy"><strong>Start Folder</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(nc.startFolder || "All Files")}</span><svg class="settings-dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
    </div>
    <p class="settings-group-label">Contact Backup</p>
    <div class="settings-list-card">
      <div class="settings-toggle-row"><span><strong>Automatic Sync</strong><small>Automatic sync works with one cloud service at a time.</small></span><label class="switch-control"><input type="checkbox" data-nc-auto ${nc.autoBackup ? "checked" : ""}><span></span></label></div>
      ${lastSynced > 0 ? `<div class="settings-list-row settings-info-row"><span class="settings-row-copy"><strong>Last synced</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(new Date(lastSynced).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</span></div>` : ""}
      <button class="settings-list-row" type="button" data-nc-pick-backup><span class="settings-row-copy"><strong>Backup Folder</strong></span><span class="settings-dropdown-caption">${deps.escapeHtml(nc.backupFolder || `${DEFAULT_BACKUP_FOLDER} (default)`)}</span><svg class="settings-dropdown-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>
      <button class="settings-list-row" type="button" data-nc-backup-now><span class="settings-row-copy"><strong>Back Up Contacts Now</strong></span></button>
      <div class="settings-list-row settings-info-row" data-nc-last-backup-row hidden><span class="settings-row-copy"><strong>Last backup</strong></span><span class="settings-dropdown-caption" data-nc-last-backup></span></div>
      <div class="settings-list-row settings-info-row" data-nc-backup-status-row hidden><span class="settings-row-copy"><small data-nc-backup-status></small></span></div>
      <div class="settings-list-row settings-info-row" data-nc-backup-result-row hidden><span class="settings-row-copy"><small data-nc-backup-result></small></span></div>
    </div>
    <p class="settings-group-footer">Only your contacts are backed up here, encrypted. Your messages and group chats come back with your seed phrase.</p>
    ${needsReconnect ? `<p class="settings-group-footer settings-footer-error" role="alert">Nextcloud refused this login. Disconnect, then connect again with a new app password.</p>` : ""}
    <p class="settings-group-label">Portfolio Backup</p>
    <div class="settings-list-card">
      <button class="settings-list-row" type="button" data-nc-portfolio-backup><span class="settings-row-copy"><strong>Back Up Portfolio Now</strong></span></button>
      <div class="settings-list-row settings-info-row" data-nc-portfolio-result-row hidden><span class="settings-row-copy"><small data-nc-portfolio-result></small></span></div>
    </div>
    <p class="settings-group-footer">Each portfolio has its own file, named after it. These files aren't encrypted.</p>
    <div class="settings-list-card danger-list-card">
      <button class="settings-list-row danger-row" type="button" data-nc-disconnect><span class="settings-row-copy"><strong>Disconnect</strong></span></button>
    </div>`;
  updateComposerButton();
  refreshBackupStatusLine();
}

async function refreshBackupStatusLine() {
  const line = settingsEl?.querySelector("[data-nc-backup-status]");
  if (!line || !nc) return;
  const info = await fetchBackupInfo();
  const current = settingsEl?.querySelector("[data-nc-backup-status]");
  if (!current) return;
  // iOS: a "Last backup" row (date · size), or the line "No backup on this server yet."
  const statusRow = settingsEl?.querySelector("[data-nc-backup-status-row]");
  const lastRow = settingsEl?.querySelector("[data-nc-last-backup-row]");
  const lastValue = settingsEl?.querySelector("[data-nc-last-backup]");
  if (!info) {
    current.textContent = "No backup on this server yet.";
    if (statusRow) statusRow.hidden = false;
    if (lastRow) lastRow.hidden = true;
    return;
  }
  if (statusRow) statusRow.hidden = true;
  if (!info.modified) { if (lastRow) lastRow.hidden = true; return; }
  const when = info.modified.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const size = info.size ? ` · ${formatFileSize(info.size)}` : "";
  if (lastValue) lastValue.textContent = `${when}${size}`;
  if (lastRow) lastRow.hidden = false;
}

/// The Back Up Now result under the rows (iOS backupStatusMessage in green, backupErrorMessage in red).
function setBackupResult(message, isError = false) {
  const row = settingsEl?.querySelector("[data-nc-backup-result-row]");
  const text = settingsEl?.querySelector("[data-nc-backup-result]");
  if (!row || !text) return;
  text.textContent = message || "";
  text.style.color = isError ? "var(--ios-red)" : "var(--ios-green)";
  row.hidden = !message;
}

function updateComposerButton() {
  const button = document.querySelector("[data-nextcloud-pick]");
  if (button) button.hidden = !nc;
}

// ---------------------------------------------------------------------------
// Picker modal (media send + folder selection, one modal, in-place navigation)
// ---------------------------------------------------------------------------

let pickerOnPicked = null;
/// "File" (send from Nextcloud) for a composer other than the 1:1 one (group chats): the picked
/// file's share link goes to `onPicked` instead of the default stager.
export function openNextcloudMediaPicker({ onPicked = null } = {}) {
  if (!nc) { deps.showToast?.("Connect Nextcloud in Settings → Storage first."); return false; }
  pickerOnPicked = onPicked;
  openPicker("media");
  return true;
}

function openPicker(mode) {
  pickerMode = mode;
  pickerOpen = true;
  pickerStack = [];
  pickerPath = mode === "media" ? (nc.startFolder || "") : mode === "file" ? backupFolderPath() : "";
  const modal = modalsEl.querySelector("[data-nc-picker-modal]");
  if (modal) modal.hidden = false;
  loadPickerFolder();
}

function closePicker() {
  pickerOpen = false;
  pickerOnPicked = null;
  const modal = modalsEl?.querySelector("[data-nc-picker-modal]");
  if (modal) modal.hidden = true;
}

async function loadPickerFolder() {
  pickerLoading = true;
  pickerError = null;
  pickerFiles = [];
  renderPicker();
  try {
    pickerFiles = await listFolder(pickerPath);
  } catch (error) {
    // The KaChat folder doesn't exist until something is first saved to it: that reads as empty.
    if (!(pickerMode === "file" && error?.status === 404)) pickerError = corsHint(error);
  }
  pickerLoading = false;
  renderPicker();
  hydratePickerThumbnails();
}

function pickerTitle() {
  if (!pickerPath) return pickerMode === "media" || pickerMode === "file" ? "Nextcloud" : "All Files";
  return pickerPath.split("/").pop();
}

function renderPicker() {
  const body = modalsEl?.querySelector("[data-nc-picker-body]");
  const titleEl = modalsEl?.querySelector("[data-nc-picker-title]");
  const chooseBtn = modalsEl?.querySelector("[data-nc-picker-choose]");
  const allFilesBtn = modalsEl?.querySelector("[data-nc-picker-allfiles]");
  const backBtn = modalsEl?.querySelector("[data-nc-picker-back]");
  if (!body) return;
  if (titleEl) titleEl.textContent = pickerTitle();
  if (chooseBtn) {
    chooseBtn.hidden = pickerMode === "media" || pickerMode === "file";
    chooseBtn.textContent = pickerPath ? "Use This Folder" : "Use All Files";
  }
  if (allFilesBtn) allFilesBtn.hidden = !((pickerMode === "media" || pickerMode === "file") && (pickerPath || pickerStack.length));
  if (backBtn) backBtn.hidden = pickerStack.length === 0;

  const folders = pickerFiles.filter((f) => f.isDirectory)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const media = pickerMode === "media"
    ? pickerFiles.filter((f) => f.isImage || f.isVideo)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    : [];
  // Everything else (audio, PDFs, docs, …) is sendable too — listed as rows under the grid.
  const others = pickerMode === "media"
    ? pickerFiles.filter((f) => !f.isDirectory && !f.isImage && !f.isVideo)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    : [];
  const plainFiles = pickerMode === "file"
    ? pickerFiles.filter((f) => !f.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    : [];

  body.innerHTML = `
    ${pickerError ? `<p class="field-error nc-picker-error">${deps.escapeHtml(pickerError)}</p>` : ""}
    ${folders.map((folder) => `
      <button class="nc-folder-row" type="button" data-nc-open-folder="${deps.escapeHtml(folder.path)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5A2 2 0 0 1 5.5 4.5h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/></svg>
        <span>${deps.escapeHtml(folder.name)}</span>
        <svg class="nc-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>`).join("")}
    ${media.length ? `<div class="nc-grid">${media.map((file) => `
      <button class="nc-cell" type="button" data-nc-pick-file="${deps.escapeHtml(file.path)}" data-nc-thumb="${deps.escapeHtml(file.path)}">
        <span class="nc-cell-icon">${file.isVideo
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3Z"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m5 17 4.5-4.5 3.2 3.2 2.3-2.3L19 17"/></svg>'}</span>
        ${file.isVideo ? '<span class="nc-play">▶</span>' : ""}
        <span class="nc-cell-busy" hidden></span>
      </button>`).join("")}</div>` : ""}
    ${others.map((file) => `
      <button class="nc-folder-row nc-file-row" type="button" data-nc-pick-file="${deps.escapeHtml(file.path)}">
        ${fileRowIcon(file)}
        <span>${deps.escapeHtml(file.name)}</span>
        ${file.size ? `<small>${(file.size / 1024).toFixed(0)} KB</small>` : ""}
      </button>`).join("")}
    ${plainFiles.map((file) => {
      const pickable = pickerAllowedExtensions?.has(fileExtension(file.path));
      const detail = [file.size ? formatFileSize(file.size) : "", file.modified && !Number.isNaN(file.modified.getTime()) ? file.modified.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : ""].filter(Boolean).join(" · ");
      return `
      <button class="nc-folder-row nc-file-row nc-plain-file${pickable ? " pickable" : ""}" type="button" data-nc-pick-file="${deps.escapeHtml(file.path)}" ${pickable ? "" : "disabled"}>
        ${fileRowIcon(file)}
        <span class="nc-plain-file-copy"><span>${deps.escapeHtml(file.name)}</span>${detail ? `<small>${deps.escapeHtml(detail)}</small>` : ""}</span>
      </button>`;
    }).join("")}
    ${!pickerLoading && !folders.length && !media.length && !others.length && !plainFiles.length && !pickerError
      ? `<p class="nc-empty">${pickerMode === "media" || pickerMode === "file" ? "This folder is empty." : "No subfolders."}</p>` : ""}
    ${pickerLoading ? '<p class="nc-empty">Loading…</p>' : ""}`;
}

/** A size people read at a glance: KB up to 1000 KB, then MB (never "42566.1 KB"). */
function formatFileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} bytes`;
  const kb = n / 1024;
  if (kb < 1000) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return mb < 1000 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

function fileRowIcon(file) {
  const ext = fileExtension(file.path);
  const type = file.contentType || "";
  if (type.startsWith("audio/") || ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"].includes(ext)) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>';
  }
  if (ext === "pdf" || type.includes("pdf")) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>';
}

async function hydratePickerThumbnails() {
  if (pickerMode !== "media") return;
  const cells = Array.from(modalsEl?.querySelectorAll("[data-nc-thumb]") || []);
  for (const cell of cells) {
    if (!pickerOpen) return;
    const path = cell.dataset.ncThumb;
    const url = await thumbnailURL(path);
    if (!pickerOpen) return;
    const background = cssUrlValue(url, { allowLocal: true }); // a blob: object URL (DSK-016)
    if (background && cell.isConnected) {
      cell.style.backgroundImage = background;
      cell.classList.add("has-thumb");
    }
  }
}

async function pickMediaFile(path) {
  if (pickerSharingPath) return;
  pickerSharingPath = path;
  const cell = modalsEl?.querySelector(`[data-nc-pick-file="${CSS.escape(path)}"] .nc-cell-busy`);
  if (cell) cell.hidden = false;
  try {
    const url = await createPublicShareLink(path);
    // Stage the link in the composer for review instead of auto-sending — the user presses
    // send themselves (matches iOS/Android). A group composer hands in its own stager, read
    // before closePicker drops it.
    const stage = pickerOnPicked || deps.stageComposerText;
    pickerOnPicked = null;
    pickerSharingPath = null;
    closePicker();
    stage?.(url);
  } catch (error) {
    pickerSharingPath = null;
    if (cell) cell.hidden = true;
    pickerError = corsHint(error);
    renderPicker();
    hydratePickerThumbnails();
  }
}

function chooseCurrentFolder() {
  const chosen = pickerPath || null;
  if (pickerMode === "folder-start") {
    nc.startFolder = chosen;
  } else if (pickerMode === "folder-backup") {
    nc.backupFolder = chosen; // null = default KaChat folder
    // A different folder means a different file: the remembered ETag describes the old one, so
    // drop it and let the watcher take a fresh look.
    delete nc.lastBackupEtag;
  }
  saveState();
  closePicker();
  renderSettings();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function buildModals() {
  modalsEl = document.createElement("div");
  modalsEl.innerHTML = `
    <div class="modal-backdrop nc-picker-backdrop" data-nc-picker-modal hidden>
      <div class="contact-modal nc-picker-modal" role="dialog" aria-modal="true" aria-label="Nextcloud files">
        <div class="modal-header">
          <div class="nc-picker-head">
            <button class="kaposts-icon-button" type="button" data-nc-picker-back aria-label="Back" hidden>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7"/></svg>
            </button>
            <div><p class="modal-kicker">Nextcloud</p><h2 data-nc-picker-title>Nextcloud</h2></div>
          </div>
          <div class="nc-picker-actions">
            <button class="cold-inline-link" type="button" data-nc-picker-allfiles hidden>All Files</button>
            <button class="modal-close" type="button" data-nc-picker-close aria-label="Close">×</button>
          </div>
        </div>
        <div class="nc-picker-body" data-nc-picker-body></div>
        <div class="modal-actions">
          <button class="primary-button" type="button" data-nc-picker-choose hidden>Use This Folder</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modalsEl);

  modalsEl.addEventListener("click", (event) => {
    if (event.target.closest("[data-nc-picker-close]")) { closePicker(); return; }
    if (event.target.closest("[data-nc-picker-back]")) {
      pickerPath = pickerStack.pop() ?? "";
      loadPickerFolder();
      return;
    }
    if (event.target.closest("[data-nc-picker-allfiles]")) {
      pickerStack = [];
      pickerPath = "";
      loadPickerFolder();
      return;
    }
    if (event.target.closest("[data-nc-picker-choose]")) { chooseCurrentFolder(); return; }
    const openFolder = event.target.closest("[data-nc-open-folder]");
    if (openFolder) {
      pickerStack.push(pickerPath);
      pickerPath = openFolder.dataset.ncOpenFolder;
      loadPickerFolder();
      return;
    }
    const pickFile = event.target.closest("[data-nc-pick-file]");
    if (pickFile && pickerMode === "file") {
      if (pickFile.disabled) return;
      const onPicked = pickerOnPicked;
      const file = pickerFiles.find((f) => f.path === pickFile.dataset.ncPickFile);
      closePicker();
      if (file) onPicked?.(file);
      return;
    }
    if (pickFile) { pickMediaFile(pickFile.dataset.ncPickFile); }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (pickerOpen) closePicker();
  });
}

function wireSettings() {
  settingsEl?.addEventListener("click", async (event) => {
    if (event.target.closest("[data-nc-connect]")) {
      const rawServer = String(settingsEl.querySelector("[data-nc-server]")?.value || "").trim();
      const errorEl0 = settingsEl.querySelector("[data-nc-connect-error]");
      if (rawServer.toLowerCase().startsWith("http://")) {
        if (errorEl0) { errorEl0.textContent = "Use https. Unencrypted connections are not supported."; errorEl0.hidden = false; }
        return;
      }
      const server = normalizedServer(rawServer);
      const username = String(settingsEl.querySelector("[data-nc-username]")?.value || "").trim();
      const appPassword = String(settingsEl.querySelector("[data-nc-password]")?.value || "").trim();
      const errorEl = settingsEl.querySelector("[data-nc-connect-error]");
      const showError = (message) => { if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; } };
      if (!server) { showError("That doesn't look like a valid server URL."); return; }
      if (!username || !appPassword) { showError("Enter your username and an app password."); return; }
      const button = event.target.closest("[data-nc-connect]");
      button.disabled = true;
      button.textContent = "Connecting…";
      try {
        const userId = await verifyCredentials(server, username, appPassword);
        // Automatic Sync starts off (the owner's call, 2026-10-13; iOS bde94b0 switched it on at
        // connect): the person picks the folder first.
        nc = { server, username, userId: userId || null, appPassword, startFolder: null, backupFolder: null, autoBackup: false, lastAutoBackup: 0 };
        try { saveState({ strict: true }); }
        catch (error) { nc = null; throw error; } // locked meanwhile: not connected, nothing stored
        ncLocked = null;
        renderSettings();
        armAutoBackup();
        deps.showToast?.("Nextcloud connected.");
        // Contacts the phone already keeps on this server: find their folder and pick it up, rather
        // than sitting on an empty default.
        adoptExistingBackupFolder().catch(() => {});
      } catch (error) {
        button.textContent = "Connect";
        button.disabled = !ncConnectFormValid();
        showError(corsHint(error));
      }
      return;
    }
    if (event.target.closest("[data-nc-disconnect]")) {
      const ok = await confirmDialog({ title: "Disconnect Nextcloud", message: "The app password is removed from this device. You can reconnect any time.", confirmLabel: "Disconnect", destructive: true });
      if (!ok) return;
      const leaving = nc;
      nc = null;
      ncLocked = null;
      syncDirty = false;
      needsReconnect = false;
      lastAutoSyncAt = 0;
      clearStoredState();
      revokeAppPassword(leaving);
      armAutoBackup();  // stops the watcher, the heartbeat and the debounce
      renderSettings();
      return;
    }
    if (event.target.closest("[data-nc-pick-start]")) { openPicker("folder-start"); return; }
    if (event.target.closest("[data-nc-pick-backup]")) { openPicker("folder-backup"); return; }
    if (event.target.closest("[data-nc-portfolio-backup]")) {
      const button = event.target.closest("[data-nc-portfolio-backup]");
      const result = settingsEl.querySelector("[data-nc-portfolio-result]");
      const row = settingsEl.querySelector("[data-nc-portfolio-result-row]");
      const say = (text, failed = false) => {
        if (!result || !row) return;
        result.textContent = text;
        result.classList.toggle("error", failed);
        row.hidden = !text;
      };
      if (button) button.disabled = true;
      say("");
      try {
        await runPortfolioBackup();
        say("Portfolio backed up.");
      } catch (error) {
        say(error?.message || "The backup failed.", true);
      } finally {
        if (button) button.disabled = false;
      }
      return;
    }
    if (event.target.closest("[data-nc-backup-now]")) {
      // The manual button bypasses the debounce and the automatic-sync floor, but still waits
      // for whatever already owns the contacts rather than racing it.
      if (syncInFlight) { setBackupResult("A sync is already running. Try again in a moment.", true); return; }
      const button = event.target.closest("[data-nc-backup-now]");
      if (button) button.disabled = true;
      setBackupResult("");
      syncInFlight = true;
      syncDirty = false;
      try {
        await runBackup();
        lastAutoSyncAt = Date.now();
        nc.lastAutoBackup = lastAutoSyncAt;
        saveState();
        // iOS backUpNow: "Contacts backed up." under the rows, not a toast.
        setBackupResult("Contacts backed up.");
      } catch (error) {
        syncDirty = true;
        setBackupResult(corsHint(error), true);
      } finally {
        if (button?.isConnected) button.disabled = false;
        syncInFlight = false;
      }
      refreshBackupStatusLine();
      return;
    }
  });

  settingsEl?.addEventListener("input", (event) => {
    if (event.target.matches("[data-nc-server], [data-nc-username], [data-nc-password]")) refreshConnectFormState();
  });

  settingsEl?.addEventListener("change", (event) => {
    if (event.target.matches("[data-nc-auto]")) {
      if (!nc) return;
      nc.autoBackup = event.target.checked;
      saveState();
      armAutoBackup();
      // Switched on: the first upload happens promptly.
      noteContactActivity();
    }
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** Deletes the encrypted contacts file from the user's Nextcloud, and the old chat backup with it:
 *  this is the account going away, the one time KaChat still touches that file. Only ever on the
 *  user's say-so (the Delete Account option that names it). 404 is the state asked for. */
export async function deleteRemoteNextcloudBackup() {
  if (!nc?.server || !nc?.username || !nc?.appPassword) return;
  const davRoot = `${apiBase()}/remote.php/dav/files/${davUser()}`;
  const folder = backupFolderPath().split("/").map(encodeURIComponent).join("/");
  // The portfolios' files too. One that can't be read stays, as does anything of another account's.
  const wallet = addressBookWalletAddress();
  let portfolioNames = [];
  try { portfolioNames = wallet ? (await readServerPortfolios(wallet)).own.map((found) => found.file.name) : []; }
  catch (error) { deps.appendEngineLog?.(`[Nextcloud] Reading the Portfolio files to delete them failed: ${error.message}`); }
  for (const name of [BACKUP_FILENAME, ...RETIRED_BACKUP_FILENAMES, ...SINGLE_PORTFOLIO_FILENAMES, ...portfolioNames]) {
    const response = await ncFetch(`${davRoot}/${folder}/${encodeURIComponent(name)}`, { method: "DELETE", headers: { Authorization: authHeader() } });
    if (response.status === 401) throw new Error("Nextcloud rejected the stored app password. Reconnect in Settings.");
    if (!(response.ok || response.status === 404)) throw new Error(`Nextcloud returned HTTP ${response.status}.`);
  }
  rememberBackupETag(null);
  deps.appendEngineLog?.("[Nextcloud] Remote backup deleted");
}

export function isNextcloudConnected() {
  return Boolean(nc);
}

/** The connected account, for the call service: server origin, login and app password. */
export function nextcloudAccount() {
  if (!nc?.server || !nc?.username || !nc?.appPassword) return null;
  return { server: String(nc.server).replace(/\/+$/, ""), username: nc.username, appPassword: nc.appPassword };
}

/** Whether this Nextcloud can host a KaChat call: Talk installed with calls enabled, read from
 *  the server's capabilities (spreed.features incl. conversation-v4 and signaling-v3, and
 *  config.call.enabled) - iOS NextcloudService.talkCallsAvailable. A "yes" is remembered for
 *  the session; anything else asks the server again, so a call about to start (or a request to
 *  host one) re-checks Talk when it isn't known to be there. A probe that couldn't reach the
 *  server changes nothing (iOS 88aa3c1): it used to answer "no Talk", and a Desktop with Talk
 *  then asked the other side to host. */
let talkProbe = null; // { server, at, value }
export async function nextcloudTalkCallsAvailable({ force = false } = {}) {
  const account = nextcloudAccount();
  if (!account) return false;
  const known = talkProbe && talkProbe.server === account.server ? talkProbe : null;
  if (!force && known?.value && Date.now() - known.at < 6 * 3600_000) return true;
  let value = null;
  try {
    const response = await ncFetch(`${apiBase(account.server)}/ocs/v2.php/cloud/capabilities?format=json`, {
      headers: {
        Authorization: "Basic " + btoa(`${account.username}:${account.appPassword}`),
        "OCS-APIRequest": "true",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (response.ok) value = talkCallsFromCapabilities(await response.json());
  } catch { value = null; }
  if (value == null) {
    deps?.appendEngineLog?.(`[Nextcloud] Talk check could not reach the server - keeping ${Boolean(known?.value)}`);
    return Boolean(known?.value);
  }
  if (known?.value !== value) deps?.appendEngineLog?.(`[Nextcloud] Talk calls ${value ? "available" : "not available"}`);
  talkProbe = { server: account.server, at: Date.now(), value };
  return value;
}

export function resetNextcloudForAccount() {
  closePicker();
  // A wallet switch retires everything in flight before the new account's state loads: the
  // ETag, the dirty flag and the sync floor all belong to the wallet that just left.
  stopChangeWatcher();
  if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
  syncDirty = false;
  lastAutoSyncAt = 0;
  lastPortfolioCheck = 0;
  needsReconnect = false;
  portfolioFileCache = new Map();
  if (portfolioDebounceTimer) { clearTimeout(portfolioDebounceTimer); portfolioDebounceTimer = null; }
  for (const url of thumbCache.values()) { if (url) URL.revokeObjectURL(url); }
  thumbCache = new Map();
  loadState();
  renderSettings();
  armAutoBackup();
}

export function initNextcloud(dependencies) {
  deps = dependencies;
  settingsEl = document.querySelector("[data-nextcloud-settings]");
  loadState();
  // With an app password the app password opens only while KaChat is unlocked: follow the vault.
  onKeyVaultStateChanged(() => handleVaultStateChanged());
  buildModals();
  wireSettings();

  // "File" in the composer's + menu (hidden until connected): pick from Nextcloud.
  document.querySelector("[data-nextcloud-pick]")?.addEventListener("click", () => {
    document.querySelector("[data-composer-plus-menu]")?.setAttribute("hidden", "");
    if (!nc) { deps.showToast?.("Connect Nextcloud in Settings → Storage first."); return; }
    openPicker("media");
  });

  // Tab-hide is the desktop "leaving" moment — mirror iOS's on-background backup, and stop the
  // change watcher entirely (a hidden tab has its timers throttled anyway, and polling a server
  // for a window nobody is looking at is pure waste). Coming back re-arms everything and runs a
  // catch-up.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopChangeWatcher();
      if (syncDebounceTimer) { clearTimeout(syncDebounceTimer); syncDebounceTimer = null; }
      // The hide flush takes over from any pending quiet-time timer: bypass the automatic-sync
      // floor so a change that was still waiting out its debounce is not left unwritten.
      if (syncDirty) performAutomaticSync({ bypassFloor: true });
      else autoBackupIfDue();
      // A Portfolio change still owed goes now: this may be the last chance to write.
      if (portfolioDebounceTimer) { clearTimeout(portfolioDebounceTimer); portfolioDebounceTimer = null; }
      if (nc?.autoBackup && nc.portfolioBackupOwed && !needsReconnect) runPortfolioBackup().catch(() => {});
      return;
    }
    startChangeWatcherIfNeeded();
    autoBackupIfDue(AUTO_CATCHUP_MS);
    syncPortfoliosIfDue();
  });

  renderSettings();
  armAutoBackup();
  // A connection saved before this version of the folder scan gets it once.
  if (nc && nc.backupFolderScanned !== BACKUP_FOLDER_SCAN_VERSION) adoptExistingBackupFolder().catch(() => {});
}
