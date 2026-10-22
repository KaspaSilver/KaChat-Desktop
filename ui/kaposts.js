// KaPosts tab UI — desktop port of iOS's KaPostsView. Self-contained: app.js calls
// initKaPosts(...) once with the shared helpers, and everything else lives here.
//
// State model mirrors iOS/Android: local session posts (optimistic composer output) overlay
// the indexer feed until their txids round-trip; post/quote/like/dislike submits are held
// behind a 5-second undo countdown — cancel and nothing ever touches the network.

import { fitBackgroundBanner } from "./banner-fit.js";
import { safeCssUrl } from "./css-url.js";
import { userFacingError } from "./dialogs.js";
import { splitTypedName, primary as primaryName } from "../engine/name-services.js";
import {
  KAPOSTS_POST_CHARACTER_LIMIT,
  fetchFollowingFeed,
  fetchFollowListAll,
  fetchFollowListPage,
  fetchPost,
  fetchChainPost,
  fetchThread,
  fetchGlobalFeed,
  fetchKaPostNotifications,
  fetchKaPostUserDetails,
  fetchPostEngagement,
  fetchPostTippers,
  fetchReplies,
  fetchUserPosts,
  fetchUserReplies,
  decodePostContent,
  nextPageCursor,
  stripKaChatMarker,
  kaspaAddressFromPubkey,
  requesterPubkeyFor,
  submitKaPost,
  submitKaPostFollow,
  submitKaPostQuote,
  submitKaPostReply,
  submitKaPostUnquote,
  submitKaPostEdit,
  submitKaPostDelete,
  KAPOSTS_EDIT_WINDOW_MS,
  submitKaPostVote,
  submitKaPoll,
  submitKaPollVote,
  fetchPoll,
  buildScheduledPost,
  scheduleOnServer,
  cancelScheduledOnServer,
  fetchScheduledPosts,
  submitScheduledLocally,
  KAPOSTS_POLL_MIN_OPTIONS,
  KAPOSTS_POLL_MAX_OPTIONS,
  KAPOSTS_POLL_OPTION_MAX_LENGTH,
  pollOptionLength,
  prefixPollOption,
  KAPOSTS_SCHEDULE_MIN_MS,
  KAPOSTS_SCHEDULE_MAX_MS,
  pollClosesAt,
} from "../engine/kaposts.js";
import { setReservedOutpoints } from "../engine/transactions.js";
import { getEndpoint } from "../engine/endpoints.js";
import { KAS_UNIT } from "../engine/network.js";
import { decodeAddress, AddressVersion } from "../engine/kachat-names/registry-state.js";
import { kasTextFromSompi } from "../engine/amounts.js";
import { renderKaPostsMarkdown, applyKaPostsMarkdownAction } from "./kaposts-markdown.js";
import {
  kapostsCharCount,
  kapostsClampChars,
  kapostsFoldedPrefix,
  kapostsEditWindowText,
  kapostsLongRelativeTime,
  kapostsNamedRelativeTime,
} from "./kaposts-format.js";
// Who a poster is: their .kachat name, avatar, banner and bio (iOS 3d6fb7c, KachatLive.identityName /
// profileBanner / profileBio). Profiles are on every network (mainnet: profile-only identities).
import { kachatCachedLabel, kachatCachedAvatarUrl, kachatCachedProfilePieces, kachatRetryImage, onKachatIdentityChange } from "./kachat-names-live.js";
import { kachatNamesUiEnabled } from "./kachat-names-runtime.js";
// Imported, not a string path: Vite only rewrites and emits assets it can SEE, and a path inside
// a template literal is invisible to it - which left this 404ing on the built site.
import kaspaLogoUrl from "./assets/kaspa-logo.png";

const UNDO_DELAY_MS = 5000;
const KAPOSTS_PREFS_KEY = "kachat-kaposts-prefs-v1"; // { following:[], muted:[], blocked:[] } — account-scoped

// Replies posted this session, by txid: kept at the top of their thread until the indexer
// returns them (iOS 7f82118).
const sessionReplyIds = new Set();
let deps = null; // { engine, escapeHtml, shortAddress, accountScopedKey, showToast, appendEngineLog }

// DOM
let feedEl, statusEl, tabsEl, threadEl, threadRootEl, threadRepliesEl, toastsEl;
let composerEl, composerInput, composerMeter, composerSubmit, composerTitle, composerQuote;

// State
let activeFeedTab = "feed";
let panelEl, panelTitleEl, panelBodyEl, popoverEl;
let panelRefreshEl = null; // the panel header's refresh button (built on first render)
// activePanel: null | {type:"profile", address, pubkey, tab, posts, replies, details, loading}
//            | {type:"notifications", items, loading}
//            | {type:"engagement", postId, postTxId, tab, lists, loading}
//            | {type:"list", kind}  (bookmarks | muted | blocked | menu)
let activePanel = null;
let myContentPosts = []; // own posts+replies fetched for share/notification resolution
let localPosts = [];      // newest first, optimistic
let remotePosts = [];
/// Posts the feed has fetched but not shown yet, behind the "Show N new posts" pill.
///
/// The feed is not rewritten under a reader's finger. Something arriving while you are three
/// screens down and pushing everything you were reading off the bottom is the behaviour this
/// avoids; the pill sits at the top until you ask for it. Matches iOS's pendingNewPosts.
let pendingNewPosts = [];
let newPostsCheckTimer = null;
let checkingForNewPosts = false;
/// iOS uses 60s, and asks for page ONE only - this answers "is there anything new", not "fetch
/// everything I missed", and tapping the pill does a proper refresh anyway.
const NEW_POSTS_CHECK_INTERVAL_MS = 60_000;
let feedLoading = false;
let feedError = null;
/// Which endpoint remotePosts was filled from ("global" | "following"). Feed and Popular share the
/// global feed, so switching between them keeps every page already loaded (iOS loadedFeedSource).
let loadedFeedSource = null;
/// When Popular last swept its ranking window; at most once per FEED_STALE_AFTER_MS unless a
/// page-one refresh threw that window away (iOS FeedLoadGates.popularSweptAt).
let popularSweptAt = 0;
function feedSourceFor(tab) { return tab === "following" ? "following" : "global"; }
let prefs = { following: [], muted: [], blocked: [] };
let threadStack = [];     // post ids (local ids)
// A panel opened from INSIDE an open thread (Post Activity, a poster's profile) presents OVER
// the thread and its Back returns to the thread — the desktop stand-in for the sheets iOS
// presents from the thread's own hierarchy. False = the thread owns the viewport.
let panelOverThread = false;
// Reply-notification landing: the txid of the reply to scroll to once the parent thread's
// comment list contains it, and the txid currently flashing after that landing.
let pendingThreadScrollRemoteId = null;
let threadHighlightRemoteId = null;
let threadHighlightTimer = 0;
let replyInput, replyMeter, replySend;
let composerQuoteTarget = null; // post being quoted, when the composer is a quote composer
let composerPoll = null;        // { options: [..], lengthMs } while the composer carries a poll
let composerScheduleAt = null;  // ms when the post should go out, while scheduling
let composerReplyTarget = null; // post being replied to, when the composer is a reply composer
let composerEditTarget = null;  // one of our own posts being edited (iOS 2d483a7): Save replaces its text
let countdownTicker = null;
let savedFeedScroll = 0;
// The KaPosts scroller's last position while it was on screen: a hidden tab can come back at the
// top, and returning to the tab puts the reader back where they were (iOS c18fb77).
let contentScrollTop = 0;

// Endless-scroll state (see the "Endless scrolling" section below)
let feedPager = null;
let feedGeneration = 0;   // bumped on every reload/tab switch/account reset — stale-response guard
let threadGeneration = 0;
let panelGeneration = 0;
let lastFeedLoadAt = 0;
let renderedFeedIds = new Set(); // what the feed DOM currently holds, so appends never duplicate
const threadPagers = new Map();  // post id -> pager (a nested thread keeps its own cursor)

function kapostsScrollEl() {
  return document.querySelector(".kaposts-content");
}

function rememberFeedScroll() {
  // Only when actually LEAVING the feed (not when moving between thread levels/panels).
  if (threadStack.length === 0 && !activePanel) {
    savedFeedScroll = kapostsScrollEl()?.scrollTop || 0;
  }
}

function restoreFeedScroll() {
  requestAnimationFrame(() => {
    const el = kapostsScrollEl();
    if (el && threadStack.length === 0 && !activePanel) el.scrollTop = savedFeedScroll;
  });
}

// key -> { deadline, timer, undo() } — pending 5s-undo actions
const pendingActions = new Map();

function nowId() {
  return typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `id-${Date.now()}-${Math.random()}`;
}

// ---------------------------------------------------------------------------
// Persistence (per account)
// ---------------------------------------------------------------------------

function loadPrefs() {
  try {
    const raw = localStorage.getItem(deps.accountScopedKey(KAPOSTS_PREFS_KEY));
    const parsed = raw ? JSON.parse(raw) : null;
    prefs = {
      following: Array.isArray(parsed?.following) ? parsed.following : [],
      muted: Array.isArray(parsed?.muted) ? parsed.muted : [],
      blocked: Array.isArray(parsed?.blocked) ? parsed.blocked : [],
    };
  } catch {
    prefs = { following: [], muted: [], blocked: [] };
  }
}

function savePrefs() {
  localStorage.setItem(deps.accountScopedKey(KAPOSTS_PREFS_KEY), JSON.stringify(prefs));
}

function isHiddenAuthor(address) {
  return prefs.muted.includes(address) || prefs.blocked.includes(address);
}

// KaPosts' bell (iOS a6bd60a KaPostsWatchStore, PUSH_EXTENSIONS.md 3a): the people this account
// wants to hear from whenever they post. Kept per account (each account is its own KaPosts
// identity), and follows the current account by itself through the account-scoped key.
// iOS sends the list to its push service as `kaposts_watch_authors` on every change; so does this
// app's Web Push registration (ui/web-push.js, as author keys read from these addresses).
const KAPOSTS_WATCH_KEY = "kachat-kaposts-watch-v1"; // [lowercased kaspa: address] - account-scoped
let watchCache = null; // { key, addresses: Set }

function watchedAuthors() {
  const key = deps.accountScopedKey(KAPOSTS_WATCH_KEY);
  if (watchCache?.key === key) return watchCache.addresses;
  let stored = [];
  try { stored = JSON.parse(localStorage.getItem(key) || "[]"); } catch { stored = []; }
  watchCache = { key, addresses: new Set((Array.isArray(stored) ? stored : []).map((a) => String(a).toLowerCase())) };
  return watchCache.addresses;
}

function isWatchingAuthor(address) {
  return watchedAuthors().has(String(address || "").toLowerCase());
}
/** The bell list, for the push registration (ui/web-push.js). Empty before KaPosts has started. */
export function kaPostsWatchedAuthorAddresses() {
  if (!deps) return [];
  try { return [...watchedAuthors()]; } catch { return []; }
}

/** Turns the bell on or off for `address`; returns whether it is now on. */
function toggleWatchAuthor(address) {
  const key = String(address || "").toLowerCase();
  const own = String(deps.engine.address || "").toLowerCase();
  if (!key || !own || key === own) return false;
  const set = new Set(watchedAuthors());
  const on = !set.has(key);
  if (on) set.add(key); else set.delete(key);
  const storageKey = deps.accountScopedKey(KAPOSTS_WATCH_KEY);
  watchCache = { key: storageKey, addresses: set };
  try { localStorage.setItem(storageKey, JSON.stringify([...set].sort())); } catch { /* kept for this session */ }
  return on;
}

// What the bell just did, said for a moment under the name wherever that post shows (iOS bellNote):
// post id -> text, cleared after 2.8 s unless a newer note replaced it.
const bellNotes = new Map();

function toggleBell(post) {
  const on = toggleWatchAuthor(post.posterAddress);
  deps.onPushPreferencesChanged?.(); // the push registration carries the bell list
  const name = posterName(post.posterAddress);
  const note = on
    ? `You'll now be notified when ${name} posts.`
    : `You won't be notified about ${name}'s posts anymore.`;
  // The feed and thread, and a panel showing post cells (bookmarks, a profile, search) on top.
  const repaint = () => { renderAll(); if (activePanel) repaintPosterIdentities(); };
  bellNotes.set(post.id, note);
  repaint();
  window.setTimeout(() => {
    if (bellNotes.get(post.id) !== note) return;
    bellNotes.delete(post.id);
    repaint();
  }, 2800);
}

// ---------------------------------------------------------------------------
// Identity (contact custom name > KNS primary > short address; .kas stripped)
// ---------------------------------------------------------------------------

// Every link the apps hand out is https://kachat.app/... (KACHAT_APP_LINKS.md): it unfurls a
// preview in any chat app, opens the installed app on a phone, and shows the post otherwise.
function postShareLink(remoteId) {
  return `https://kachat.app/post/${encodeURIComponent(String(remoteId || ""))}`;
}

function posterName(address) {
  if (!address) return "Unknown";
  // Your saved contact name wins, then their KNS domain, then the short address —
  // same order iOS resolves display names for notifications and posts.
  // The .kas suffix is part of the name and shows everywhere (iOS a7c0c5e); typing never needs
  // it - resolution appends it and mention suggestions match on the bare name.
  const alias = deps.contactAliasFor?.(address);
  if (alias) return alias;
  // Who they are: their .kachat name, like the rest of the app (iOS 3d6fb7c; a .kas domain isn't
  // identity since 5.2). Null on mainnet until names launch; it lands on its own
  // (onKachatIdentityChange repaints).
  if (kachatNamesUiEnabled()) {
    const label = kachatCachedLabel(address);
    if (label) return label;
  } else {
    // A .kas name is no one's identity (iOS 509c0fe).
    const info = deps.engine.knsNamesAsIdentity ? deps.engine.peekKnsAddressInfo?.(address) : null;
    const domain = info?.explicitPrimaryDomain || info?.primaryDomain || "";
    if (domain) return domain;
  }
  // No name: the app's one short form, kaspa:xxxx....xxxx (iOS a80d271).
  return deps.defaultAlias ? deps.defaultAlias(address) : deps.shortAddress(address);
}

const POSTER_GLYPH_SVG = '<svg viewBox="0 0 24 24"><path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.118a7.5 7.5 0 0 1 15 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.5-1.632Z"/></svg>';

function posterAvatarHtml(address) {
  // The poster's .kachat avatar (yours on your own posts and profile), every network (iOS 3d6fb7c):
  // never the KNS picture where .kachat is identity. A picture that won't load retries once through
  // the relay, then shows the glyph (handlePosterImageError).
  const avatarUrl = kachatNamesUiEnabled()
    ? kachatCachedAvatarUrl(address)
    : deps.engine.peekKnsAddressProfile?.(address)?.profile?.avatarUrl;
  if (avatarUrl) {
    const kachat = kachatNamesUiEnabled() ? ' referrerpolicy="no-referrer" data-kaposts-kachat-img="avatar"' : "";
    return `<span class="kaposts-avatar"><img src="${deps.escapeHtml(avatarUrl)}" alt="" loading="lazy"${kachat} /></span>`;
  }
  // Person glyph fallback (4.0 look — no initials).
  return `<span class="kaposts-avatar kaposts-avatar-fallback" aria-hidden="true">${POSTER_GLYPH_SVG}</span>`;
}

/** The .kachat banner and bio of a profile page (iOS 3d6fb7c, KachatLive.profileBanner /
 *  profileBio), else - only where .kachat isn't identity - the KNS profile's. */
function posterProfilePieces(address) {
  if (kachatNamesUiEnabled()) {
    const pieces = kachatCachedProfilePieces(address) || {};
    return { bannerUrl: pieces.bannerUrl || null, bio: String(pieces.bio || "").trim() || null, kachat: true };
  }
  const kns = deps.engine.peekKnsAddressProfile?.(address)?.profile || null;
  return { bannerUrl: kns?.bannerUrl || null, bio: String(kns?.bio || "").trim() || null, kachat: false };
}

/** A .kachat picture in KaPosts that would not load: one retry through the relay, then the
 *  avatar goes back to the glyph and a banner goes away. */
function handlePosterImageError(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.hasAttribute("data-kaposts-kachat-img")) return;
  const failed = img.getAttribute("src") || "";
  const giveUp = () => {
    if (img.dataset.kapostsKachatImg === "banner") { img.remove(); return; }
    const holder = img.parentElement;
    img.remove();
    if (holder && !holder.querySelector("img")) {
      holder.classList.add("kaposts-avatar-fallback");
      holder.setAttribute("aria-hidden", "true");
      holder.innerHTML = POSTER_GLYPH_SVG;
    }
  };
  if (!failed || img.dataset.kapostsRetried === failed) { giveUp(); return; }
  img.dataset.kapostsRetried = failed;
  kachatRetryImage(failed).then((next) => {
    if (!img.isConnected || img.getAttribute("src") !== failed) return;
    if (next) { img.dataset.kapostsRetried = next; img.src = next; } else giveUp();
  }, giveUp);
}

/** When a cached .kachat answer lands (a name, a face, a banner, a bio), repaint what KaPosts has
 *  on screen - at most once a second; offscreen it waits for the tab to come back. */
let posterRepaintTimer = null;
let posterRepaintAt = 0;
let posterRepaintPending = false;
function kapostsOnScreen() {
  const root = kapostsScrollEl();
  return Boolean(root && root.getClientRects().length > 0 && !document.hidden);
}
function schedulePosterRepaint() {
  if (posterRepaintTimer) return;
  const wait = Math.max(0, 1000 - (Date.now() - posterRepaintAt));
  posterRepaintTimer = window.setTimeout(() => {
    posterRepaintTimer = null;
    posterRepaintAt = Date.now();
    if (!kapostsOnScreen()) { posterRepaintPending = true; return; }
    repaintPosterIdentities();
  }, wait);
}
function repaintPosterIdentities() {
  posterRepaintPending = false;
  try {
    const thread = currentThreadPost();
    if (activePanel && (!thread || panelOverThread)) {
      if (activePanel.type === "search") renderSearchResults(activePanel);
      else renderPanel();
    } else if (thread) {
      renderThread();
    } else {
      renderFeed();
    }
  } catch (error) {
    deps?.appendEngineLog?.(`KaPosts .kachat repaint failed: ${error?.message || error}`);
  }
}

/**
 * KNS names/avatars for a batch of freshly appended rows. Goes through the engine's
 * refreshKnsIfNeeded — ONE pass that dedupes, skips addresses already cached and honours
 * the per-address backoff — never a request per post. Re-renders only when it actually
 * fetched something (the caller's render reads the warm cache synchronously via peek*).
 */
let knsRefreshInFlight = false;
async function resolvePosterIdentities(addresses, onResolved) {
  if (!deps?.engine?.refreshKnsIfNeeded) return;
  const unique = [...new Set((addresses || []).filter(Boolean))].slice(0, 60);
  if (unique.length === 0) return;
  const fetched = await deps.engine.refreshKnsIfNeeded(unique).catch(() => 0);
  if (fetched) onResolved?.();
}

async function refreshVisiblePosterNames() {
  if (knsRefreshInFlight) return;
  knsRefreshInFlight = true;
  try {
    await resolvePosterIdentities(visibleFeedPosts().slice(0, 30).map((p) => p.posterAddress), () => renderFeed());
  } finally {
    knsRefreshInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Endless scrolling (shared paginator)
// ---------------------------------------------------------------------------
//
// Every KaPosts list is server-paginated with an opaque cursor ({hasMore, nextCursor}) but
// CLIENT-FILTERED afterwards: engine/kaposts.js keeps only KaChat-marked content, then muted
// and blocked authors drop out here, then the Following tab intersects with the local follow
// list and the profile Posts tab drops replies. A 50-row page can therefore yield ZERO
// visible rows, so "one fetch per sentinel hit" would either stall forever or thrash. Instead
// runPager keeps pulling pages until it has PAGER_TARGET_ROWS NEW VISIBLE rows or the server
// runs out — capped at PAGER_MAX_REQUESTS requests per trigger so one scroll can never
// stampede the indexer.

const PAGER_PAGE_SIZE = 50;
const PAGER_THREAD_PAGE_SIZE = 100;
const PAGER_TARGET_ROWS = 18;
const PAGER_MAX_REQUESTS = 5;
const PAGER_MAX_UNPRODUCTIVE = 1; // one all-filtered trigger (five requests) and we ask for a tap (iOS KaPostsPaginator)
// Page one loaded within this window is current enough to keep: coming back to the tab keeps the
// pages scrolled in and only looks for newer posts (iOS c18fb77, FeedLoadGates.staleAfter).
const FEED_STALE_AFTER_MS = 5 * 60_000;

function makePager({ pageSize = PAGER_PAGE_SIZE, target = PAGER_TARGET_ROWS } = {}) {
  return {
    cursor: null,
    hasMore: true,
    loading: false,
    error: null,
    stalled: false,
    unproductive: 0,
    seen: new Set(), // raw server ids already absorbed — dedupe across pages
    pageSize,
    target,
  };
}

/** Primes a pager from the surface's FIRST page (the one the open/refresh path fetched). */
function seedPager(pager, rawItems, pagination, idOf = (item) => item?.id) {
  if (!pager) return;
  pager.seen = new Set();
  for (const item of rawItems || []) {
    const id = idOf(item);
    if (id) pager.seen.add(String(id));
  }
  pager.cursor = nextPageCursor(pagination);
  pager.hasMore = Boolean(pager.cursor);
  pager.loading = false;
  pager.error = null;
  pager.stalled = false;
  pager.unproductive = 0;
}

/**
 * The filter-shrinkage loop. `fetchPage(before, limit)` returns {items, pagination};
 * `absorb(freshItems)` merges them into the surface's model, paints them and returns how many
 * VISIBLE rows that produced; `isStale()` reports whether the surface has moved on (tab
 * switch, panel close, thread pop, account change) — a stale response is dropped whole and
 * the cursor is left untouched, so the surface that comes back is never fed the old list's
 * rows. Exactly one run per pager at a time.
 */
async function runPager(pager, { fetchPage, absorb, isStale, onUpdate, idOf = (item) => item?.id }) {
  if (!pager || pager.loading || pager.stalled || !pager.hasMore || pager.error) return;
  pager.loading = true;
  onUpdate?.();
  let addedVisible = 0;
  let requests = 0;
  try {
    while (pager.hasMore && addedVisible < pager.target && requests < PAGER_MAX_REQUESTS) {
      requests += 1;
      const cursor = pager.cursor;
      const page = await fetchPage(cursor, pager.pageSize);
      if (isStale()) return; // drop the response AND keep the cursor where it was
      const items = Array.isArray(page?.items) ? page.items : [];
      const fresh = [];
      for (const item of items) {
        const id = idOf(item);
        if (!id) continue;
        const key = String(id);
        if (pager.seen.has(key)) continue;
        pager.seen.add(key);
        fresh.push(item);
      }
      const next = nextPageCursor(page?.pagination);
      pager.cursor = next;
      // Stop when the server runs out, repeats its cursor, or hands back a page we have
      // already absorbed in full — an indexer that silently ignored `before` would
      // otherwise re-serve page one forever.
      pager.hasMore = Boolean(next) && next !== cursor && !(items.length > 0 && fresh.length === 0);
      addedVisible += absorb(fresh) || 0;
    }
  } catch (error) {
    if (!isStale()) pager.error = error?.message || "Could not load more posts.";
    deps.appendEngineLog?.(`KaPosts load-more failed: ${userFacingError(error)}`);
  } finally {
    pager.loading = false;
    if (!isStale()) {
      // Nothing visible came back but the server still has rows: allow a few more automatic
      // sweeps, then fall back to an explicit "Load more" so we never spin on a feed whose
      // every page is filtered away.
      pager.unproductive = addedVisible > 0 ? 0 : pager.unproductive + 1;
      pager.stalled = pager.hasMore && !pager.error && pager.unproductive >= PAGER_MAX_UNPRODUCTIVE;
      onUpdate?.();
    }
  }
}

// --- sentinel + IntersectionObserver lifecycle -----------------------------

const pagerObservers = new Map(); // sentinel key -> IntersectionObserver
const pagerLoaders = new Map();   // sentinel key -> { pager, load } (for the retry button)

/** Nearest scrolling ancestor, so rootMargin prefetch works inside .kaposts-panel-body too. */
function scrollRootFor(element) {
  let node = element?.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

function clearPagerSentinel(key) {
  pagerObservers.get(key)?.disconnect();
  pagerObservers.delete(key);
  pagerLoaders.delete(key);
}

function clearPanelPagerSentinels() {
  for (const key of ["profile-posts", "profile-replies", "notifications", "engagement", "engagement-tips", "tippers", "followList"]) {
    clearPagerSentinel(key);
  }
}

function clearAllPagerSentinels() {
  for (const observer of pagerObservers.values()) observer.disconnect();
  pagerObservers.clear();
  pagerLoaders.clear();
}

function pagerFooterHtml(pager, key) {
  if (pager.loading) {
    return `<span class="kaposts-pager-spinner" aria-hidden="true"></span><span>Loading more...</span>`;
  }
  if (pager.error) {
    return `<button type="button" class="kaposts-pager-failure" data-kaposts-pager-retry="${deps.escapeHtml(key)}">
              <strong>Couldn't load more</strong>
              <span class="kaposts-pager-error">${deps.escapeHtml(pager.error)}</span>
              <span class="kaposts-pager-retry-hint">Tap to retry</span>
            </button>`;
  }
  if (pager.stalled) {
    return `<button type="button" data-kaposts-pager-retry="${deps.escapeHtml(key)}">Load more</button>`;
  }
  return "";
}

/**
 * (Re)places the bottom sentinel for `key` inside `container` and re-arms its observer.
 * Called at the END of every render of that surface — because the module rewrites list
 * innerHTML, the previous sentinel node is detached, and re-arming here (after an explicit
 * disconnect) is what keeps observers from leaking across views. Once the surface reports
 * end-of-list the sentinel is removed and nothing is observed at all.
 */
function mountPagerSentinel(key, container, pager, load) {
  clearPagerSentinel(key);
  container?.querySelector?.(`[data-kaposts-sentinel="${key}"]`)?.remove();
  if (!container || !pager) return;
  if (!pager.hasMore && !pager.loading && !pager.error) return; // end reached — stop observing
  const sentinel = document.createElement("div");
  sentinel.className = "kaposts-pager";
  sentinel.dataset.kapostsSentinel = key;
  sentinel.innerHTML = pagerFooterHtml(pager, key);
  container.appendChild(sentinel);
  pagerLoaders.set(key, { pager, load });
  if (pager.loading || pager.error || pager.stalled) return; // busy or waiting on the user
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) load();
  }, { root: scrollRootFor(sentinel), rootMargin: "0px 0px 600px 0px" });
  observer.observe(sentinel);
  pagerObservers.set(key, observer);
}

function retryPager(key) {
  const entry = pagerLoaders.get(key);
  if (!entry) return;
  entry.pager.error = null;
  entry.pager.stalled = false;
  entry.pager.unproductive = 0;
  entry.load();
}

// ---------------------------------------------------------------------------
// Feed data
// ---------------------------------------------------------------------------

/** A banner URL fit for a CSS url(): http(s) only, with every character that could close the
 *  url() or the declaration percent-encoded (escapeHtml's entities are decoded before CSS). */
const TX_ID_PATTERN = /^[0-9a-f]{64}$/i;
const txIdOrNull = (value) => (TX_ID_PATTERN.test(String(value || "")) ? String(value) : null);
function mapRemotePost(post) {
  // Every id from the indexer is a transaction id, and they end up in markup: anything else is
  // not a post, whatever a hostile or broken indexer sends.
  if (!txIdOrNull(post?.id)) return null;
  const content = decodePostContent(post);
  const address = kaspaAddressFromPubkey(deps.engine, post.userPublicKey);
  if (content === null || !address) return null;
  let quoted = null;
  if (post.quote?.referencedSenderPubkey) {
    const quotedText = post.quote.referencedMessage ? decodePostContent({ postContent: post.quote.referencedMessage }) : null;
    const quotedAddress = kaspaAddressFromPubkey(deps.engine, post.quote.referencedSenderPubkey);
    if (quotedText !== null && quotedAddress) {
      quoted = {
        remoteId: txIdOrNull(post.quote.referencedContentId), text: stripKaChatMarker(quotedText), posterAddress: quotedAddress,
        timestamp: Number(post.quote.timestamp) || null,
      };
    }
  }
  return {
    id: `remote-${post.id}`, // stable identity across refreshes
    remoteId: post.id,
    posterPubkey: post.userPublicKey,
    posterAddress: address,
    // who each @token meant when the author wrote it; a tap opens one of these (iOS e493c97)
    mentionedPubkeys: Array.isArray(post.mentionedPubkeys) ? post.mentionedPubkeys.filter((k) => typeof k === "string") : [],
    text: stripKaChatMarker(content),
    timestamp: Number(post.timestamp) || Date.now(),
    likes: post.upVotesCount || 0,
    dislikes: post.downVotesCount || 0,
    reposts: post.quotesCount || 0,
    // How many times it was tipped (KAPOSTS_INDEXER.md 5.11, iOS a6bd60a); absent on an older indexer.
    tips: Number(post.tipsCount) || 0,
    likedByMe: post.isUpvoted === true,
    dislikedByMe: post.isDownvoted === true,
    repostedByMe: false,
    remoteReplyCount: post.repliesCount || 0,
    comments: [],
    quoted,
    parentRemoteId: txIdOrNull(post.parentPostId),
    delivery: "sent",
    // Set by the indexer once an edit was accepted; the cell shows "· edited".
    editedAt: post.editedAt ? Number(post.editedAt) || null : null,
    sentAt: null,
    poll: mapRemotePoll(post.poll),
  };
}

// A poll rides on a post (KAPOSTS_INDEXER.md §5.9): options (base64 on the wire), the counts,
// the closing time and the requester's vote. An older indexer serves the poll as a plain post.
function mapRemotePoll(poll) {
  if (!poll || !Array.isArray(poll.options) || poll.options.length < 2) return null;
  const options = poll.options.map((b64) => { try { return decodePostContent({ postContent: b64 }) ?? ""; } catch { return ""; } });
  const counts = Array.isArray(poll.counts) ? poll.counts.map((n) => Number(n) || 0) : options.map(() => 0);
  return {
    options,
    counts,
    total: Number(poll.total ?? counts.reduce((a, b) => a + b, 0)) || 0,
    closesAt: Number(poll.closesAt) || 0,
    myVote: Number.isInteger(poll.myVote) ? poll.myVote : null,
  };
}

function fetchFeedPage(before, limit = PAGER_PAGE_SIZE) {
  const args = { engine: deps.engine, limit, before };
  // "Popular" is the global feed re-sorted client-side, so it pages the same endpoint.
  return activeFeedTab === "following" ? fetchFollowingFeed(args) : fetchGlobalFeed(args);
}

/** Page one. Resets the endless-scroll window: new cursor, cleared end-reached, top of list. */
// One-shot per session: rebuild the LOCAL follow set from the on-chain follow graph. Every
// Follow button and the Following tab filter read prefs.following, which lives only in
// localStorage — a cleared profile left users "following 0" with Follow buttons beside
// people they already follow on-chain. Chain entries are only ever ADDED (never removed),
// so a just-clicked local unfollow the indexer hasn't caught up on can't be resurrected.
let followingChainSynced = false;
async function syncFollowingFromChain() {
  if (followingChainSynced) return;
  followingChainSynced = true;
  try {
    const pubkey = safeRequesterPubkey();
    if (!pubkey) { followingChainSynced = false; return; }
    const raw = await fetchFollowListAll({ engine: deps.engine, pubkey, followers: false });
    const merged = new Set(prefs.following);
    // A stale self-follow (an early build let you follow yourself) inflates your own count.
    merged.delete(deps.engine.address);
    for (const item of raw || []) {
      const rowPubkey = item?.userPublicKey || item?.publicKey || item?.pubkey || item?.followedPubkey || item?.user || "";
      const address = item?.address || kaspaAddressFromPubkey(deps.engine, rowPubkey) || "";
      if (address) merged.add(address);
    }
    merged.delete(deps.engine.address || "");
    if (merged.size !== prefs.following.length) {
      prefs.following = [...merged];
      savePrefs();
      renderAll();
    }
  } catch (error) {
    followingChainSynced = false; // network miss - retry on the next feed load
    // Logged rather than swallowed: when this failed silently, the Following tab rendered
    // "Nothing here yet" with nothing anywhere saying the follow list had never loaded.
    deps.appendEngineLog?.(`KaPosts follow-list sync failed: ${userFacingError(error)}`);
  }
}

/// Asks whether anything newer than the top of the loaded feed exists, without touching what is
/// on screen.
async function checkForNewPosts() {
  if (!deps || checkingForNewPosts || feedLoading || !remotePosts.length) return;
  if (deps.kaPostsSuppressed?.()) return;
  const source = feedSourceFor(activeFeedTab);
  if (source !== loadedFeedSource) return;
  checkingForNewPosts = true;
  try {
    const result = await fetchFeedPage(null);
    // The feed may have been refreshed or switched while this was in flight.
    if (source !== loadedFeedSource || feedLoading) return;
    const known = new Set(remotePosts.map((post) => post.remoteId).filter(Boolean));
    // Page one against what is on screen, muted and blocked authors left out: the pill never
    // counts a post it would not show (iOS checkForNewPosts).
    const fresh = result.posts
      .map(mapRemotePost)
      .filter(Boolean)
      .filter((post) => post.remoteId && !known.has(post.remoteId) && !isHiddenAuthor(post.posterAddress));
    if (fresh.length) {
      pendingNewPosts = fresh;
      renderAll();
    }
  } catch { /* the next tick asks again; a missed check costs nothing */ }
  finally {
    checkingForNewPosts = false;
  }
}

/// Folds the held-back posts into the feed and goes back to the top.
function showPendingNewPosts() {
  if (!pendingNewPosts.length) return;
  const known = new Set(remotePosts.map((post) => post.remoteId).filter(Boolean));
  remotePosts = [...pendingNewPosts.filter((post) => !known.has(post.remoteId)), ...remotePosts];
  pendingNewPosts = [];
  renderAll();
  kapostsScrollEl()?.scrollTo({ top: 0, behavior: "smooth" });
}

/// Only while the feed is actually on screen, the way iOS ties its check to the view's lifetime -
/// nothing polls in the background for a tab nobody is looking at.
function startNewPostsCheck() {
  if (newPostsCheckTimer) return;
  newPostsCheckTimer = window.setInterval(() => {
    if (document.hidden) return;
    checkForNewPosts();
  }, NEW_POSTS_CHECK_INTERVAL_MS);
}

function stopNewPostsCheck() {
  if (!newPostsCheckTimer) return;
  window.clearInterval(newPostsCheckTimer);
  newPostsCheckTimer = null;
}

function newPostsPillHtml() {
  if (!pendingNewPosts.length) return "";
  const count = pendingNewPosts.length;
  // Floating over the feed, not a row in it (iOS overlay): a reader scrolled past a row would never
  // learn there is anything new. The zero-height sticky holder keeps it at the top of the screen.
  return `<div class="kaposts-new-pill-holder"><button class="kaposts-new-pill" type="button" data-kaposts-show-new>`
    + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`
    + `<span>${count === 1 ? "Show 1 new post" : `Show ${count} new posts`}</span></button></div>`;
}

async function loadFeed() {
  if (kapostsUnavailableHere()) { renderKaPostsUnavailable(); return; }
  syncFollowingFromChain();
  // The KaPosts tab can be clicked before initKaPosts has run (startup awaits storage/engine
  // first) — deps is still null then, and every deps.* access below would throw.
  if (!deps) return;
  const generation = ++feedGeneration; // any in-flight page from the previous tab is now stale
  clearPagerSentinel("feed");
  feedPager = makePager();
  // The page being fetched owns the footer's spinner (iOS feedPage.isLoading): "Loading more..."
  // under the posts already on screen, a spinner under the empty state when there are none.
  feedPager.loading = true;
  loadedFeedSource = feedSourceFor(activeFeedTab);
  feedLoading = true;
  feedError = null;
  renderStatus();
  renderFeed();
  let loaded = false;
  try {
    const result = await fetchFeedPage(null);
    if (generation !== feedGeneration) return;
    remotePosts = result.posts.map(mapRemotePost).filter(Boolean);
    // A refresh just delivered whatever the pill was offering.
    pendingNewPosts = [];
    seedPager(feedPager, result.posts, result.pagination);
    loaded = true;
    // A refresh re-arms Popular's deep sweep: the window it ranked was just thrown away.
    popularSweptAt = 0;
  } catch (error) {
    if (generation !== feedGeneration) return;
    feedError = userFacingError(error);
    // A failed refresh keeps whatever is already on screen, and the footer offers the retry
    // (iOS KaPostsLoadMoreFooter: "Couldn't load more" / the reason / "Tap to retry").
    feedPager.loading = false;
    feedPager.error = feedError;
    deps.appendEngineLog?.(`KaPosts feed load failed: ${feedError}`);
  } finally {
    if (generation === feedGeneration) {
      feedLoading = false;
      if (loaded) lastFeedLoadAt = Date.now();
      renderStatus();
      renderFeed({ resetScroll: loaded });
      refreshVisiblePosterNames();
    }
  }
}

// Popular ranks over a real window of history, not over whatever page one happened to hold:
// with one page loaded, "most popular" meant "the most-liked of the last few dozen posts", and
// a genuinely big post from last week never appeared. Sweeps up to POPULAR_RANKING_DEPTH posts
// (or POPULAR_SWEEP_MAX_PASSES pager runs - a muted stretch of history can return two visible
// rows for a whole pass, so depth alone is not a bound) before trusting its own order. Runs only
// while Popular is on screen; a tab switch bumps feedGeneration, which this checks between passes.
const POPULAR_RANKING_DEPTH = 300;
const POPULAR_SWEEP_MAX_PASSES = 4;
let popularDeepening = false;
async function deepenPopularRanking() {
  if (activeFeedTab !== "popular" || popularDeepening || !feedPager) return;
  // At most once per staleness window unless page one was refreshed in between (iOS
  // FeedLoadGates.popularSweptAt): a heavily filtered stretch of history never reaches the depth,
  // and every return to the tab would otherwise re-spend the whole request budget chasing it.
  if (popularSweptAt && Date.now() - popularSweptAt < FEED_STALE_AFTER_MS) return;
  popularSweptAt = Date.now();
  popularDeepening = true;
  try {
    let passes = 0;
    while (remotePosts.length < POPULAR_RANKING_DEPTH && passes < POPULAR_SWEEP_MAX_PASSES) {
      passes += 1;
      const generation = feedGeneration;
      if (activeFeedTab !== "popular" || !feedPager.hasMore || feedPager.stalled || feedPager.error || feedPager.loading) return;
      const before = remotePosts.length;
      await loadMoreFeed();
      if (generation !== feedGeneration) return;
      if (remotePosts.length <= before) return; // a pass that added nothing would loop forever
      renderFeed(); // the order is only right once the whole window is in
    }
  } finally {
    popularDeepening = false;
  }
}

/** Sentinel hit at the bottom of the feed — keeps paging until ~a screenful is visible. */
function loadMoreFeed() {
  if (!deps || !feedPager) return;
  const generation = feedGeneration;
  const pager = feedPager; // a tab switch swaps the module-level one out from under us
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = await fetchFeedPage(before, limit);
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      const known = new Set(remotePosts.map((post) => post.remoteId));
      const added = mapped.filter((post) => post.remoteId && !known.has(post.remoteId));
      remotePosts = [...remotePosts, ...added];
      const rendered = appendFeedRows(); // mute/block + Following-list filtering happens here
      resolvePosterIdentities(added.map((post) => post.posterAddress), () => renderFeed());
      return rendered;
    },
    isStale: () => generation !== feedGeneration,
    onUpdate: () => {
      if (generation === feedGeneration) mountPagerSentinel("feed", feedEl, pager, loadMoreFeed);
    },
  });
}

/** Interleaves session posts into the remote feed, newest first (iOS 77c2a89 mergeNewestFirst).
 *  The remote list keeps the server's order exactly; each local post goes in just above the first
 *  remote post older than it, and one older than the whole loaded window goes last. They used to
 *  be stacked on top, which pinned a just-sent post above everything posted after it. */
function mergeNewestFirst(local, remote) {
  if (!local.length) return remote;
  const localSorted = [...local].sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
  const merged = [];
  let li = 0;
  for (const post of remote) {
    while (li < localSorted.length && Number(localSorted[li].timestamp || 0) >= Number(post.timestamp || 0)) {
      merged.push(localSorted[li]);
      li += 1;
    }
    merged.push(post);
  }
  for (; li < localSorted.length; li += 1) merged.push(localSorted[li]);
  return merged;
}

function visibleFeedPosts() {
  const combined = mergeNewestFirst(
    localPosts,
    remotePosts.filter((r) => !localPosts.some((l) => l.remoteId && l.remoteId === r.remoteId)),
  ).filter((p) => !isHiddenAuthor(p.posterAddress));
  if (activeFeedTab === "following") return combined.filter((p) => prefs.following.includes(p.posterAddress));
  if (activeFeedTab === "popular") {
    return [...combined].sort((a, b) => engagementScore(b) - engagementScore(a));
  }
  return combined;
}

// Tree helpers (posts + nested comments)
function allPostLists() {
  const extra = [];
  if (activePanel?.type === "profile") {
    extra.push(...(activePanel.posts || []), ...(activePanel.replies || []));
  }
  return [...localPosts, ...remotePosts, ...myContentPosts, ...extra];
}

/**
 * Depth-first lookup over every collection that can hold a post node. Thread-chain copies are
 * searched LAST (iOS findPost): segments beyond the first live ONLY in threadChains, and
 * without that fallback a like/bookmark tap on a chain segment resolved to nothing at all.
 */
function findPostWhere(match) {
  const search = (list) => {
    for (const post of list || []) {
      if (match(post)) return post;
      const hit = search(post.comments);
      if (hit) return hit;
    }
    return null;
  };
  const hit = search(allPostLists());
  if (hit) return hit;
  for (const chain of threadChains.values()) {
    const chainHit = search(chain);
    if (chainHit) return chainHit;
  }
  return null;
}

function findPost(id) {
  return findPostWhere((post) => post.id === id);
}

/**
 * Applies `transform` to EVERY node carrying this id, in every collection and at any depth
 * (iOS mutatePost). Remote ids are a stable hash of the txid, so one post routinely exists as
 * several DISTINCT objects at once — a feed row, a comment nested under its parent, and a
 * thread-chain segment. Stopping at the first match updated whichever twin the search order
 * hit first, so a like/dislike/repost/bookmark made inside an open thread landed on the feed
 * twin and the thread kept rendering the untouched node until it was closed and reopened.
 * Nodes are de-duplicated by OBJECT identity: the same object can be reachable through two
 * lists (a chain segment is also its parent's comment), and a counter must not be bumped twice.
 */
function mutatePost(id, transform) {
  const visited = new Set();
  const walk = (list) => {
    for (const post of list || []) {
      if (!post || visited.has(post)) continue;
      visited.add(post);
      if (post.id === id) transform(post);
      walk(post.comments);
    }
  };
  walk(allPostLists());
  // The open thread's "Thread" section renders from threadChains copies, so sweep them too.
  for (const chain of threadChains.values()) walk(chain);
}

function findPostByRemoteId(remoteId) {
  return findPostWhere((post) => post.remoteId === remoteId);
}

/// Everything bookmarked, posts and their comments alike, newest first (iOS bookmarkedPosts:
/// posts + their comments). One row per post: the same post can sit in several loaded lists.
function bookmarkedPostsAndComments() {
  const seen = new Set();
  const out = [];
  for (const post of allPostLists()) {
    for (const entry of [post, ...(post.comments || [])]) {
      if (!entry?.bookmarkedByMe || isHiddenAuthor(entry.posterAddress) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

/** Widens the resolution pool without dropping what it already holds (dedupe by txid). */
function mergeIntoResolutionPool(mapped) {
  const known = new Set(myContentPosts.map((post) => post.remoteId).filter(Boolean));
  const fresh = (mapped || []).filter((post) => post.remoteId && !known.has(post.remoteId));
  if (fresh.length) myContentPosts = [...myContentPosts, ...fresh];
}

/**
 * Own posts + replies into the resolution pool. Deep-link/notification targets are usually
 * YOUR content, which lives outside the feed window, and a reply notification's PARENT
 * always is. Returns false when there is nothing to fetch with.
 */
async function loadOwnContentIntoResolutionPool() {
  const pubkey = safeRequesterPubkey();
  if (!pubkey) return false;
  try {
    const [ownPosts, ownReplies] = await Promise.all([
      fetchUserPosts({ engine: deps.engine, pubkey }),
      fetchUserReplies({ engine: deps.engine, pubkey }).catch(() => ({ posts: [] })),
    ]);
    mergeIntoResolutionPool([...ownPosts.posts, ...ownReplies.posts].map(mapRemotePost).filter(Boolean));
    return true;
  } catch (error) {
    deps.appendEngineLog?.(`KaPost own-content fetch failed: ${error.message}`);
    return false;
  }
}

/**
 * A resolved deep-link/notification target that is itself a REPLY opens its PARENT's thread —
 * the post that was replied to on top, the reply itself scrolled into view below — instead of
 * presenting the bare reply as a context-free thread root (iOS openResolvedPost). The parent
 * resolves from what is already loaded, then from own posts+replies; when it still cannot be
 * found, the reply's own thread opens as before.
 */
// Ancestor chains from get-thread, keyed by the post's txid and held root first.
//
// Desktop's upward context used to be the navigation stack - i.e. only what you had tapped
// through to get here - so a reply opened from a profile, a link or a notification had nothing
// above it at all, and no way to reach the post it answered.
const fetchedAncestors = new Map();
/// Posts whose long text the reader expanded in place (Show more), by local id.
const expandedPostIds = new Set();
/// Comments whose reply chain is expanded inline in the thread, by local id.
const expandedCommentIds = new Set();
/// Pulls one comment's replies into its own comments array, for inline expansion, from page one
/// of its own pager (iOS expandReplies -> loadThreadReplies(reset: true), keyed by the comment's
/// id like every thread page). The pager is what lets the expander say which state it is in -
/// "Loading replies...", the failure with Retry, or "No replies" - and lets a long chain page on.
///
/// Reading a conversation used to mean opening each reply as its own thread and tapping Back for
/// every level; expanding in place keeps you where you are.
async function loadCommentReplies(comment) {
  if (!comment?.remoteId) return;
  if (threadPagers.get(comment.id)?.loading) return;
  const pager = makePager({ pageSize: PAGER_THREAD_PAGE_SIZE });
  pager.loading = true;
  threadPagers.set(comment.id, pager);
  const generation = threadGeneration;
  renderThread();
  try {
    const page = await fetchReplies({ engine: deps.engine, postId: comment.remoteId, limit: PAGER_THREAD_PAGE_SIZE });
    if (generation !== threadGeneration || threadPagers.get(comment.id) !== pager) return;
    const replies = (page?.posts || []).map(mapRemotePost).filter(Boolean);
    seedPager(pager, page?.posts, page?.pagination);
    mutatePost(comment.id, (target) => {
      const known = new Set(target.comments.map((entry) => entry.remoteId).filter(Boolean));
      target.comments = [...target.comments, ...replies.filter((reply) => !known.has(reply.remoteId))];
    });
    resolvePosterIdentities(replies.map((reply) => reply.posterAddress), () => renderThread());
  } catch (error) {
    if (generation !== threadGeneration || threadPagers.get(comment.id) !== pager) return;
    pager.loading = false;
    pager.error = userFacingError(error);
  }
  renderThread();
}

/// The next page of an expanded comment's inline chain (its footer sentinel).
function loadMoreCommentReplies(commentId) {
  const comment = findPost(commentId);
  const pager = threadPagers.get(commentId);
  if (!comment?.remoteId || !pager) return;
  const generation = threadGeneration;
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = await fetchReplies({ engine: deps.engine, postId: comment.remoteId, limit, before });
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      let added = 0;
      mutatePost(commentId, (p) => {
        const known = new Set(p.comments.map((c) => c.remoteId).filter(Boolean));
        const rows = mapped.filter((reply) => reply.remoteId && !known.has(reply.remoteId));
        p.comments = [...p.comments, ...rows];
        added = Math.max(added, rows.filter((reply) => !isHiddenAuthor(reply.posterAddress)).length);
      });
      renderThread();
      resolvePosterIdentities(mapped.map((reply) => reply.posterAddress), () => renderThread());
      return added;
    },
    isStale: () => generation !== threadGeneration || !expandedCommentIds.has(commentId),
    onUpdate: () => renderThread(),
  });
}

/// One post from the indexer by txid, mapped and merged into the resolution pool so every later
/// findPostByRemoteId resolves it.
async function indexerPost(txId) {
  if (!txId) return null;
  try {
    const raw = await fetchPost({ engine: deps.engine, id: String(txId) });
    const mapped = raw ? mapRemotePost(raw) : null;
    if (mapped) mergeIntoResolutionPool([mapped]);
    return mapped;
  } catch { return null; }
}

/// The chain itself, for a post the indexer does not serve (iOS KaPostChainReader): published
/// seconds ago, or older than the window. Engagement counts are unknown from here; a quoted
/// post is read with a second chain read.
async function chainPost(txId) {
  const record = await fetchChainPost(txId);
  if (!record) return null;
  const address = kaspaAddressFromPubkey(deps.engine, record.authorPubkey);
  if (!address) return null;
  let quoted = null;
  if (record.action === "quote" && record.referencedId) {
    const q = await fetchChainPost(record.referencedId);
    const qAddress = q ? kaspaAddressFromPubkey(deps.engine, q.authorPubkey) : null;
    if (q && qAddress) quoted = { remoteId: q.txId, text: q.message, posterAddress: qAddress, timestamp: q.blockTimeMillis };
  }
  const post = {
    id: `remote-${record.txId}`, remoteId: record.txId, posterPubkey: record.authorPubkey, posterAddress: address,
    text: record.message, timestamp: record.blockTimeMillis || Date.now(),
    likes: 0, dislikes: 0, reposts: 0, likedByMe: false, dislikedByMe: false, repostedByMe: false,
    remoteReplyCount: 0, comments: [], quoted,
    parentRemoteId: record.action === "reply" ? record.referencedId : null,
    delivery: "sent", editedAt: null, sentAt: null, poll: null,
  };
  // Real numbers and this viewer's own votes from get-post-engagement, which answers for any post
  // id, instead of a row of zeros (iOS chainEngagement). A quote counts as a repost.
  try {
    const { engagement } = await fetchPostEngagement({ engine: deps.engine, postId: record.txId });
    const me = String(safeRequesterPubkey() || "").toLowerCase();
    const isRepost = (entry) => entry?.kind === "repost" || entry?.kind === "quote";
    const mine = (entry) => Boolean(me) && String(entry?.actorPubkey || "").toLowerCase() === me;
    post.likes = engagement.filter((entry) => entry?.kind === "upvote").length;
    post.dislikes = engagement.filter((entry) => entry?.kind === "downvote").length;
    post.reposts = engagement.filter(isRepost).length;
    post.likedByMe = engagement.some((entry) => entry?.kind === "upvote" && mine(entry));
    post.dislikedByMe = engagement.some((entry) => entry?.kind === "downvote" && mine(entry));
    post.repostedByMe = engagement.some((entry) => isRepost(entry) && mine(entry));
  } catch { /* the counts stay at zero */ }
  // Replace rather than duplicate, so a like made in the thread lands on one node.
  myContentPosts = myContentPosts.filter((entry) => entry.remoteId !== post.remoteId);
  mergeIntoResolutionPool([post]);
  return post;
}

/// The complete chain above a post, fetched once per post and rendered as real cells.
async function loadAncestorsFor(post) {
  const remoteId = post?.remoteId;
  if (!remoteId || !post.parentRemoteId || fetchedAncestors.has(remoteId)) return;
  // Claimed before the await: renderThread runs many times while this is in flight, and each
  // would otherwise start its own fetch of the same chain.
  fetchedAncestors.set(remoteId, []);
  try {
    const { ancestors } = await fetchThread({ engine: deps.engine, id: remoteId });
    const mapped = (ancestors || []).map(mapRemotePost).filter(Boolean);
    if (!mapped.length) return;
    mergeIntoResolutionPool(mapped);
    fetchedAncestors.set(remoteId, mapped);
    resolvePosterIdentities(mapped.map((entry) => entry.posterAddress), () => renderThread());
    renderThread();
  } catch {
    // Unclaimed, so opening the post again retries rather than showing no context forever.
    fetchedAncestors.delete(remoteId);
  }
}

/// Who holds this comment, at any depth (iOS findParent(ofCommentId:)).
function findParentOf(id) {
  const search = (list) => {
    for (const post of list || []) {
      if ((post.comments || []).some((comment) => comment.id === id)) return post;
      const hit = search(post.comments);
      if (hit) return hit;
    }
    return null;
  };
  return search(allPostLists());
}

/// The chain above `post` from what is in memory, oldest first, for when get-thread has not
/// answered (a session post, or the moment before the fetch lands) - iOS walkAncestorChain: the
/// levels walked down through (trusted only when the last of them really holds this post), then
/// the loaded tree upward from the oldest of those, at most eight hops.
function walkAncestorChain(post) {
  let walked = threadStack.slice(0, -1).map((id) => findPost(id)).filter(Boolean);
  const last = walked[walked.length - 1];
  if (last && findParentOf(post.id)?.id !== last.id && !(last.comments || []).some((c) => c.id === post.id)) {
    walked = [];
  }
  const above = [];
  let cursor = walked[0] || post;
  for (let hops = 0; cursor && hops < 8; hops += 1) {
    const parent = findParentOf(cursor.id);
    if (!parent) break;
    // A cycle would hang the view rather than merely look wrong.
    if (above.some((entry) => entry.id === parent.id) || walked.some((entry) => entry.id === parent.id)) break;
    above.push(parent);
    cursor = parent;
  }
  return [...above.reverse(), ...walked];
}

/// Own posts and replies, unless they were loaded within the staleness window (iOS
/// reloadMyProfileIfStale). Returns whether it fetched.
let ownContentLoadedAt = 0;
async function reloadOwnContentIfStale() {
  if (ownContentLoadedAt && Date.now() - ownContentLoadedAt < FEED_STALE_AFTER_MS) return false;
  const loaded = await loadOwnContentIntoResolutionPool();
  if (loaded) ownContentLoadedAt = Date.now();
  return loaded;
}

/**
 * A resolved deep-link/notification target that is itself a REPLY opens its PARENT's thread -
 * the post that was replied to on top, the reply scrolled into view below and spliced into the
 * comments when the indexer has not caught up on it yet (iOS openResolvedPost). The parent
 * resolves from what is loaded, then own posts+replies, then the indexer, then its own
 * transaction; when it still cannot be found, the reply's own thread opens.
 */
async function openResolvedPost(post, { parentRemoteIdHint = null } = {}) {
  const parentId = post.parentRemoteId || parentRemoteIdHint || null;
  if (!parentId || parentId === post.remoteId) {
    closePanel();
    openThread(post);
    return;
  }
  let parent = findPostByRemoteId(parentId);
  if (!parent && await reloadOwnContentIfStale()) parent = findPostByRemoteId(parentId);
  // Ask the indexer for the parent directly rather than hoping a feed contains it.
  if (!parent) parent = await indexerPost(parentId);
  // Not indexed yet - read it off its own transaction.
  if (!parent) parent = await chainPost(parentId).catch(() => null);
  closePanel();
  if (parent) openThread(parent, { scrollToRemoteId: post.remoteId, ensureComment: post });
  else openThread(post);
}

/**
 * Shared-link/notification landing, in iOS openSharedPost's order: what is loaded; page one again
 * only when nothing is loaded or it is over five minutes old (a reset throws away every page the
 * reader scrolled in); own posts+replies; the notification's author's posts+replies; the indexer's
 * single-post read; the post's own transaction. Nothing found says so, with the transaction.
 */
async function resolveAndOpenPost(txId, { parentRemoteIdHint = null } = {}) {
  let post = findPostByRemoteId(txId);
  if (!post && (remotePosts.length === 0 || Date.now() - lastFeedLoadAt >= FEED_STALE_AFTER_MS)) {
    await loadFeed();
    post = findPostByRemoteId(txId);
  }
  if (!post && await reloadOwnContentIfStale()) post = findPostByRemoteId(txId);
  if (!post) {
    // Still unresolved: the txid is usually a notification's ACTING content — someone
    // ELSE's reply/quote/mentioning post, which neither the feed window nor the own-content
    // fetch above ever returns (there is no fetch-post-by-id endpoint). The notification
    // stream knows who wrote it, so fetch THAT author's posts+replies and search those.
    try {
      const { notifications } = await fetchKaPostNotifications({ engine: deps.engine, limit: 100 });
      const n = (notifications || []).find((x) => String(x?.id || "") === String(txId));
      if (n?.userPublicKey) {
        const [theirPosts, theirReplies] = await Promise.all([
          fetchUserPosts({ engine: deps.engine, pubkey: n.userPublicKey }).catch(() => ({ posts: [] })),
          fetchUserReplies({ engine: deps.engine, pubkey: n.userPublicKey }).catch(() => ({ posts: [] })),
        ]);
        const mapped = [...theirPosts.posts, ...theirReplies.posts].map(mapRemotePost).filter(Boolean);
        // myContentPosts is purely the resolution pool behind findPostByRemoteId —
        // widening it with the actor's content is safe (nothing renders it directly).
        mergeIntoResolutionPool(mapped);
        post = findPostByRemoteId(txId);
        // For a reply notification the stream's contentId IS the parent — pass it through in
        // case the fetched mapping lost parentPostId.
        if (post && n.contentType === "reply" && n.contentId) parentRemoteIdHint = String(n.contentId);
        // A reply's own thread can open directly; but when the target still isn't
        // findable, fall back to the conversation it belongs to (the parent post) — that
        // parent IS the thread to show, so it opens as the root rather than resolving
        // one level further up.
        if (!post && n.contentId) {
          const parent = findPostByRemoteId(String(n.contentId));
          if (parent) {
            closePanel();
            openThread(parent);
            return;
          }
        }
      }
    } catch (error) {
      deps.appendEngineLog?.(`KaPost actor-content fetch failed: ${error.message}`);
    }
  }
  // The indexer answers a single id, which is what every search above was working around.
  if (!post) post = await indexerPost(txId);
  // Last: the chain itself - a post the indexer has not caught up on, or one past its window.
  if (!post) post = await chainPost(txId).catch(() => null);
  if (post) {
    await openResolvedPost(post, { parentRemoteIdHint });
  } else {
    showActionToast("Post not found - it may be older than the current feed", txId);
  }
}

// ---------------------------------------------------------------------------
// 5-second undo scheduler
// ---------------------------------------------------------------------------

/** `label` overrides the key-derived toast wording (a like and an un-like share one key). */
function scheduleUndoable(key, action, undo = null, label = null) {
  cancelUndoable(key);
  const timer = setTimeout(() => {
    pendingActions.delete(key);
    stopTickerIfIdle();
    // Repaint every surface NOW rather than trusting the action to do it. The countdown is
    // not only a toast: pendingActionButtonHtml swaps the undo capsule in for the like/repost
    // button inside the post cell itself, so the cell has to be re-rendered for the button to
    // come back. The action re-renders at best one surface, and only after its network round
    // trip, which left a dead capsule on the cell.
    renderAll();
    action();
  }, UNDO_DELAY_MS);
  pendingActions.set(key, { deadline: Date.now() + UNDO_DELAY_MS, timer, undo, label });
  startTicker();
  renderAll();
}

function cancelUndoable(key) {
  const pending = pendingActions.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingActions.delete(key);
  pending.undo?.();
  stopTickerIfIdle();
  renderAll();
}

function startTicker() {
  if (countdownTicker) return;
  countdownTicker = setInterval(() => {
    document.querySelectorAll("[data-kaposts-countdown]").forEach((el) => {
      const key = el.dataset.kapostsCountdown;
      const pending = pendingActions.get(key);
      if (pending) el.textContent = String(Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000)));
    });
  }, 200);
}

function stopTickerIfIdle() {
  if (pendingActions.size === 0 && countdownTicker) {
    clearInterval(countdownTicker);
    countdownTicker = null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderFeed();
  renderThread();
  renderToasts();
}

// iOS has no feed status line: page one loading is the empty state's spinner (or the footer's
// "Loading more..." under posts already on screen), and a failed refresh is the footer's
// "Couldn't load more ... Tap to retry". The line stays hidden.
function renderStatus() {
  if (statusEl) statusEl.hidden = true;
}

const UNDO_ARROW_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;

/// A held action takes the place of its button (iOS countdownButton): the undo arrow in an
/// orange capsule, deliberately without the seconds - the ticking number belongs in the undo
/// toast. A click cancels it. Returns null when nothing is held under `key`.
function pendingActionButtonHtml(key) {
  if (!pendingActions.has(key)) return null;
  return `<button class="kaposts-action kaposts-undo-pill" type="button" data-kaposts-cancel-pending="${deps.escapeHtml(key)}" aria-label="Undo" title="Undo">${UNDO_ARROW_SVG}</button>`;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Escapes text and wraps URLs in clickable spans (confirmation popover on click). */
// @mention token: `@domain` (optionally dotted, optional .kas), not part of an email — must be
// at the start or follow whitespace / an opening bracket-quote. Matches the indexer spec so what
// highlights here is exactly what triggers a mention notification server-side.
const MENTION_PATTERN = /(^|[\s([{<"'])@([a-z0-9-]+(?:\.[a-z0-9-]+)*)/gi;
// @mentions ride on .kas names, which are no longer anyone's identity: one switch turns them off
// everywhere until they are rebuilt on .kachat (iOS 08dd836 MentionsFeature.enabled). No
// suggestions, no mentioned pubkeys on posts, and @name.kas in a post is plain text.
const MENTIONS_ENABLED = false;

// Escape a plain-text run, but wrap any @mention tokens in a highlight span first.
function escapeWithMentions(rawText) {
  const value = String(rawText || "");
  if (!MENTIONS_ENABLED) return deps.escapeHtml(value);
  let out = "";
  let last = 0;
  for (const m of value.matchAll(MENTION_PATTERN)) {
    const lead = m[1] || "";
    const domain = m[2];
    const at = m.index + lead.length; // index of the '@'
    out += deps.escapeHtml(value.slice(last, at));
    out += `<span class="kaposts-mention" data-kaposts-mention="${deps.escapeHtml(domain.toLowerCase())}">@${deps.escapeHtml(domain)}</span>`;
    last = at + 1 + domain.length;
  }
  out += deps.escapeHtml(value.slice(last));
  return out;
}

// The owner address of an @mention token (iOS KaPostsView.mentionAddress, e493c97 IOS-068/069).
// Mentions have their own rule, not the address fields' .kachat-only one:
// - with the post's signed mentions (`signed`), the answer whose owner the author signed: who the
//   token meant when it was written, whoever holds the name today;
// - otherwise the ending typed ("@bob.kas" is the .kas name), else .kachat, else .kas: the meaning
//   every post from before .kachat was written with.
async function mentionAddress(token, signed = []) {
  const results = (await deps.engine.resolveNameEverywhere?.(token)) || [];
  if (signed.length) {
    const keys = new Set(signed.map((k) => String(k).toLowerCase()));
    const typed = splitTypedName(token).tld;
    const ordered = [...results.filter((r) => r.tld === typed), ...results.filter((r) => r.tld !== typed)];
    const match = ordered.find((r) => {
      const pk = r.address ? deps.engine.kapostPubkeyForAddress?.(r.address) : null;
      return pk && keys.has(String(pk).toLowerCase());
    });
    if (match) return match.address;
  }
  return mentionResolution(token, results)?.address || null;
}

// The mention rule's answer among every service's results (iOS e493c97): the ending typed, else
// .kachat, else - a bare token with no .kachat answer - the .kas name it meant before .kachat.
function mentionResolution(token, results) {
  const winner = primaryName(results, token);
  if (winner) return winner;
  if (splitTypedName(token).tld) return null;
  return results.find((r) => r.tld === "kas" && r.address) || null;
}

// Resolve the @mentions in a post's text to the compressed pubkeys the indexer needs in
// mentioned_pubkeys. Each token keeps the ending it was typed with (iOS d0c5b09): a contact's .kas
// name resolves from the local candidate list - only for a token typed as .kas - and everyone else
// resolves live on every service, .kachat first (owner address -> pubkey). Unresolvable tokens
// stay plain text.
async function mentionedPubkeysFor(text) {
  if (!MENTIONS_ENABLED) return [];
  const tokens = [];
  const seenTokens = new Set();
  // Scanned on the RENDERED text, as iOS does, so `**@alice**` still notifies alice: the mention
  // regex wants whitespace or line start before the "@", and the bold markers would hide that.
  for (const m of renderKaPostsMarkdown(text).text.matchAll(MENTION_PATTERN)) {
    const token = m[2].toLowerCase();
    if (token && !seenTokens.has(token)) { seenTokens.add(token); tokens.push(token); }
  }
  if (!tokens.length) return [];
  const byKasName = new Map((deps.getMentionCandidates?.() || []).map((c) => [c.domain.toLowerCase(), c.pubkey]));
  const found = new Set();
  for (const token of tokens) {
    let pubkey = token.endsWith(".kas") ? (byKasName.get(token.slice(0, -4)) || null) : null;
    if (!pubkey) {
      // everyone else: the mention rule (ending typed, else .kachat, else .kas; iOS e493c97)
      try {
        const address = await mentionAddress(token);
        if (address) pubkey = deps.engine.kapostPubkeyForAddress?.(address) || null;
      } catch { /* unresolvable: plain text */ }
    }
    if (pubkey) found.add(pubkey);
  }
  return [...found];
}

// Tapped @mention anywhere in KaPosts: open the profile of whoever the author signed for the
// token (the post's mentionedPubkeys, iOS e493c97 IOS-068), else the mention rule's answer
// ("@bob.kas" stays the .kas name, iOS d0c5b09), at the resolved address (iOS 5316269) - anyone
// with a name, contact or not; never-posted owners get an honest empty profile.
// No key is handed over (iOS 474388a): the address gives only the x-only key, and a K key starts
// with 02 or 03 - the profile resolves which (XP-034), so Follow never posts for a guessed key
// (iOS 9fe4dd3). Search's open keeps its real key.
async function openMentionProfile(domain, signed = []) {
  try {
    const address = await mentionAddress(domain, signed);
    if (!address) { deps.showToast?.(`Couldn't resolve @${domain}.`); return; }
    openPosterProfile(address, null);
  } catch (error) {
    deps.showToast?.(error?.message || `Couldn't resolve @${domain}.`);
  }
}

// Style classes for one markdown span. Mentions are never styled (an identity always looks the
// same), which the caller enforces by not asking for classes inside a mention.
function markdownClassList(style) {
  const classes = [];
  if (style.bold) classes.push("kaposts-md-b");
  if (style.italic) classes.push("kaposts-md-i");
  if (style.underline) classes.push("kaposts-md-u");
  if (style.strikethrough) classes.push("kaposts-md-s");
  if (style.subtext) classes.push("kaposts-md-sub");
  return classes;
}

// Post text ready to render: KaChat markdown applied (see ui/kaposts-markdown.js), bare URLs and
// @mentions made clickable. Markdown runs FIRST, because it decides what the text actually reads
// as (markers gone, bullets and numbers materialised) and the URL/mention offsets have to be into
// that string, not the source. Its spans are then layered over the same offsets.
//
// An explicit [label](url) wins over whatever the URL detector made of the same characters; a
// span crossing a mention styles the pieces either side of it, never the mention itself.
function linkifyPostText(text, { interactive = true } = {}) {
  const rendered = renderKaPostsMarkdown(String(text || ""));
  const value = rendered.text;
  if (!rendered.hasFormatting) return interactive ? linkifyPlainText(value) : deps.escapeHtml(value);

  const urls = [];
  for (const match of value.matchAll(URL_PATTERN)) {
    urls.push({ start: match.index, end: match.index + match[0].length, url: match[0] });
  }
  const mentions = [];
  for (const m of value.matchAll(MENTION_PATTERN)) {
    const at = m.index + (m[1] || "").length;
    const end = at + 1 + m[2].length;
    // A mention inside a bare URL is part of the URL, as the plain path already treats it.
    if (urls.some((u) => at >= u.start && at < u.end)) continue;
    mentions.push({ start: at, end, domain: m[2] });
  }
  const boundaries = new Set([0, value.length]);
  for (const r of [...urls, ...mentions, ...rendered.spans]) { boundaries.add(r.start); boundaries.add(r.end); }
  const cuts = [...boundaries].filter((n) => n >= 0 && n <= value.length).sort((a, b) => a - b);

  let out = "";
  for (let k = 0; k + 1 < cuts.length; k += 1) {
    const a = cuts[k];
    const b = cuts[k + 1];
    if (b <= a) continue;
    const piece = deps.escapeHtml(value.slice(a, b));
    const mention = mentions.find((m) => a >= m.start && b <= m.end);
    if (mention) {
      out += interactive && MENTIONS_ENABLED
        ? `<span class="kaposts-mention" data-kaposts-mention="${deps.escapeHtml(mention.domain.toLowerCase())}">${piece}</span>`
        : piece;
      continue;
    }
    const span = rendered.spans.find((sp) => a >= sp.start && b <= sp.end);
    const url = urls.find((u) => a >= u.start && b <= u.end);
    const classes = span ? markdownClassList(span.style) : [];
    const href = span?.style.link || url?.url || null;
    if (href && interactive) {
      out += `<span class="kaposts-link ${classes.join(" ")}" data-kaposts-link="${deps.escapeHtml(href)}">${piece}</span>`;
    } else if (href) {
      out += `<span class="kaposts-md-linktext ${classes.join(" ")}">${piece}</span>`;
    } else if (classes.length) {
      out += `<span class="${classes.join(" ")}">${piece}</span>`;
    } else {
      out += piece;
    }
  }
  return out;
}

// The pre-markdown path, kept for the overwhelmingly common plain post: URLs and mentions only.
function linkifyPlainText(value) {
  let result = "";
  let last = 0;
  for (const match of value.matchAll(URL_PATTERN)) {
    result += escapeWithMentions(value.slice(last, match.index));
    const url = match[0];
    result += `<span class="kaposts-link" data-kaposts-link="${deps.escapeHtml(url)}">${deps.escapeHtml(url)}</span>`;
    last = match.index + url.length;
  }
  result += escapeWithMentions(value.slice(last));
  return result;
}

// A quoted post's text for a preview card: markdown styling applied, but nothing tappable. The
// card is itself a button through to the quoted post, and a tappable link inside it would compete
// with that (iOS KaPostCellView.markdownPreview).
function markdownPreviewHtml(text) {
  return linkifyPostText(text, { interactive: false });
}

const ICONS = {
  comment: `<svg viewBox="0 0 24 24"><path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm3.75 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM21 12c0 4.556-4.03 8.25-9 8.25a9.76 9.76 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/></svg>`,
  repost: `<svg viewBox="0 0 24 24"><path d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"/></svg>`,
  like: `<svg viewBox="0 0 24 24"><path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>`,
  dislike: `<svg viewBox="0 0 24 24"><path d="M7.498 15.25H4.372c-1.026 0-1.945-.694-2.054-1.715a12.137 12.137 0 0 1-.068-1.285c0-2.848.992-5.464 2.649-7.521C5.287 4.247 5.886 4 6.504 4h4.016a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23h1.294M7.498 15.25c.618 0 .991.724.725 1.282A7.471 7.471 0 0 0 7.5 19.75 2.25 2.25 0 0 0 9.75 22a.75.75 0 0 0 .75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 0 0 2.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384m-10.253 1.5H9.7m8.075-9.75c.01.05.027.1.05.148.593 1.2.925 2.55.925 3.977 0 1.487-.36 2.89-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398-.306.774-1.086 1.227-1.918 1.227h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 0 0 .303-.54"/></svg>`,
  share: `<svg viewBox="0 0 24 24"><path d="M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z"/></svg>`,
  bookmark: `<svg viewBox="0 0 24 24"><path d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"/></svg>`,
  tip: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.25"/><path d="M13.8 9.4c-.4-.7-1.1-1.15-2-1.15-1.24 0-2.05.83-2.05 1.83 0 1 .8 1.5 2.05 1.8 1.25.3 2.05.8 2.05 1.8 0 1-.81 1.84-2.05 1.84-.9 0-1.6-.45-2-1.15M11.85 6.7v10.6"/></svg>`,
};

// The head of a quoted-post card: a small avatar, the author's bold name and when they posted,
// so the quote reads as the post it is rather than a bare paragraph.
const sentCheckTimers = new Set();
function scheduleSentCheckExpiry(postId, at) {
  if (sentCheckTimers.has(postId)) return;
  sentCheckTimers.add(postId);
  setTimeout(() => { sentCheckTimers.delete(postId); renderAll(); }, Math.max(0, at - Date.now()) + 50);
}

// `withTime`: the composer's card also says when it was posted, relatively (iOS quotedPostCard:
// "5 minutes ago"); the feed's quote embed shows only the face and the name.
function quoteCardHeadHtml(quoted, { withTime = false } = {}) {
  const when = withTime && quoted.timestamp ? kapostsNamedRelativeTime(Number(quoted.timestamp)) : "";
  return `<span class="kaposts-quote-head">
    ${posterAvatarHtml(quoted.posterAddress)}
    <strong>${deps.escapeHtml(posterName(quoted.posterAddress))}</strong>
    ${when ? `<span class="kaposts-cell-time">${deps.escapeHtml(when)}</span>` : ""}
  </span>`;
}

// The poll under the question (iOS 3b1aecf): options as buttons until you vote or the poll
// closes, then bars with percentages, your choice marked, the vote count and the time left.
// When the post was made (iOS b31ff59): the full date and time, in its own row under the
// actions, in the browser's locale. The name line carries only Follow / Following.
// iOS DateFormatter (.medium date, .short time): in English that reads "Oct 17, 2026 at 7:54 AM",
// where the browser's Intl writes a comma; other languages keep Intl's own joining.
function postTimestamp(timestampMs) {
  const date = new Date(Number(timestampMs) || Date.now());
  if (/^en\b/i.test(navigator.language || "en")) {
    return `${date.toLocaleDateString([], { dateStyle: "medium" })} at ${date.toLocaleTimeString([], { timeStyle: "short" })}`;
  }
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function pollCardHtml(post) {
  const poll = post.poll;
  if (!poll) return "";
  const pid = deps.escapeHtml(String(post.id)); // DSK-015: never trust an id inside markup
  const closed = Boolean(poll.closesAt) && Date.now() >= poll.closesAt;
  const voted = poll.myVote != null;
  const showResults = closed || voted;
  // A held vote changes nothing yet (iOS votePoll applies it when the transaction lands): the
  // options stay, disabled, each with a clock at its end.
  const pending = pendingActions.has(`vote:${post.id}`);
  const canVote = !showResults && !pending && Boolean(post.remoteId) && post.delivery !== "failed";
  const clock = pending ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>` : "";
  const total = Math.max(0, Number(poll.total) || 0);
  const rows = poll.options.map((option, index) => {
    const count = Number(poll.counts?.[index]) || 0;
    const share = total > 0 ? count / total : 0;
    if (!showResults) {
      return `<button class="kaposts-poll-option" type="button" data-kaposts-poll-vote="${pid}" data-index="${index}" ${canVote ? "" : "disabled"}><span>${deps.escapeHtml(option)}</span>${clock}</button>`;
    }
    return `
      <div class="kaposts-poll-bar${poll.myVote === index ? " mine" : ""}">
        <span class="kaposts-poll-fill" style="width:${Math.round(share * 100)}%"></span>
        <span class="kaposts-poll-label">${deps.escapeHtml(option)}${poll.myVote === index ? " ✓" : ""}</span>
        <span class="kaposts-poll-pct">${Math.round(share * 100)}%</span>
      </div>`;
  }).join("");
  const left = poll.closesAt - Date.now();
  const timeLeft = closed ? "Final results" : !poll.closesAt ? "" : left < 60 * 60 * 1000
    ? `${Math.max(1, Math.floor(left / 60000))}m left`
    : left < 24 * 60 * 60 * 1000 ? `${Math.floor(left / 3600000)}h left` : `${Math.floor(left / 86400000)}d left`;
  return `
    <div class="kaposts-poll" data-kaposts-poll="${pid}">
      ${rows}
      <div class="kaposts-poll-meta">${total} vote${total === 1 ? "" : "s"}${timeLeft ? ` · ${deps.escapeHtml(timeLeft)}` : ""}</div>
    </div>`;
}

// The bell beside Follow (iOS "bell" / "bell.fill"): outlined off, filled on (.kaposts-bell.on).
const KAPOSTS_BELL_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"/></svg>`;

function postCellHtml(post, { inThread = false, isRoot = false, replyInline = true, openByRemote = false, truncates = false, showReply = true } = {}) {
  const pid = deps.escapeHtml(String(post.id)); // DSK-015: never trust an id inside markup
  const name = posterName(post.posterAddress);
  const isMine = post.posterAddress === deps.engine.address;
  const isFollowing = prefs.following.includes(post.posterAddress);
  // The bell beside Follow, and what it just did (iOS a6bd60a).
  const isWatching = !isMine && isWatchingAuthor(post.posterAddress);
  const bellNote = bellNotes.get(post.id) || "";
  // How many times it was tipped (iOS 8015069): inside the Tip button, beside it like the likes
  // beside the heart. Your own post has no Tip button: its Kaspa logo and count show on their own,
  // and a click lists who tipped (Post Activity > Tips lists them for any post).
  const tips = Math.max(0, Number(post.tips) || 0);
  // Measured on the text on screen (a translation can run longer than the original), with the
  // line count over the first 281 characters, as iOS does.
  const shownText = postDisplayText(post);
  const isLong = kapostsCharCount(shownText) > 280 || (shownText.slice(0, 281).match(/\n/g) || []).length >= 8;
  // Show more expands the post IN PLACE now. It used to open the thread, so the only way to read
  // a long post in a feed was to leave the feed - and on an ancestor it did nothing useful at
  // all. Opening the post is what tapping the post itself is for.
  // Ancestors fold too (iOS truncates: true): the focal post owns the screen, and the chain
  // above it is context you can expand or tap into, not a wall to scroll past.
  const foldText = (!inThread || truncates) && isLong && !expandedPostIds.has(post.id);
  const commentCount = Math.max(post.remoteReplyCount || 0, post.comments.filter((c) => !isHiddenAuthor(c.posterAddress)).length);

  // Delivery: a spinner while submitting, a green check for the first minute once the K
  // transaction is on the network, red Retry when it didn't go through - at the far end of the
  // action row (iOS). Only session posts and this session's replies carry a delivery state; feed
  // rows arrive as "sent" with an old timestamp and show nothing. An edit counts from the edit
  // landing (sentAt), not from the original post's time, so an edit on an old post still gets its
  // check (iOS 90331bc).
  const sentBasis = post.sentAt || post.timestamp;
  const sessionPost = Boolean(post.sentAt) || localPosts.some((p) => p.id === post.id) || sessionReplyIds.has(post.remoteId);
  const sentCheck = post.delivery === "sent" && post.remoteId && sessionPost && Date.now() - sentBasis < 60_000;
  if (sentCheck) scheduleSentCheckExpiry(post.id, sentBasis + 60_000);
  const deleting = pendingActions.has(`delete:${post.id}`) || post.pendingDeletion === true;
  const deliveryHtml = post.delivery === "pending"
    ? `<div class="kaposts-delivery pending" title="Posting"><span class="kaposts-spinner" aria-label="Posting"></span></div>`
    : post.delivery === "failed"
      ? `<div class="kaposts-delivery failed"><button type="button" data-kaposts-retry="${pid}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16v.5"/></svg>Retry</button></div>`
      : sentCheck
        ? `<div class="kaposts-delivery sent" data-kaposts-sent-check="${(Number(post.timestamp) || 0) + 60_000}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg></div>`
        : "";

  const quotedHtml = post.quoted
    ? `<div class="kaposts-quote-embed" ${post.quoted.remoteId ? `data-kaposts-open-remote="${deps.escapeHtml(post.quoted.remoteId)}"` : ""}>
         ${quoteCardHeadHtml(post.quoted)}
         <span>${markdownPreviewHtml(post.quoted.text || "")}</span>
       </div>`
    : "";

  return `
    <article class="kaposts-cell${isRoot ? " root" : ""}${!isRoot ? " openable" : ""}${deleting ? " deleting" : ""}" data-kaposts-post="${pid}"${post.remoteId ? ` data-kaposts-remote-id="${deps.escapeHtml(post.remoteId)}"` : ""}${!isRoot ? (openByRemote && post.remoteId ? ` data-kaposts-open-remote="${deps.escapeHtml(post.remoteId)}"` : ` data-kaposts-open="${pid}"`) : ""}>
      <span data-kaposts-profile="${pid}" class="kaposts-avatar-tap">${posterAvatarHtml(post.posterAddress)}</span>
      <div class="kaposts-cell-main">
        <div class="kaposts-cell-head">
          <strong class="kaposts-cell-name" data-kaposts-profile="${pid}">${deps.escapeHtml(name)}</strong>
          ${!isMine ? `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-follow="${pid}">${isFollowing ? "Following" : "Follow"}</button>` : ""}
          ${!isMine ? `<button class="kaposts-bell${isWatching ? " on" : ""}" type="button" data-kaposts-bell="${pid}" aria-label="${isWatching ? "Stop post notifications" : "Notify me when they post"}" title="${isWatching ? "Stop post notifications" : "Notify me when they post"}">${KAPOSTS_BELL_SVG}</button>` : ""}
          <button class="kaposts-action kaposts-more" type="button" data-kaposts-more="${pid}" aria-label="More">
            <svg viewBox="0 0 24 24"><path d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>
          </button>
        </div>
        ${bellNote ? `<div class="kaposts-bell-note">${deps.escapeHtml(bellNote)}</div>` : ""}
        <div class="kaposts-cell-text${foldText ? " folded" : ""}">${linkifyPostText(foldText ? kapostsFoldedPrefix(shownText) : shownText)}</div>
        ${(!inThread || truncates) && isLong ? `<button class="kaposts-show-more" type="button" data-kaposts-expand="${pid}">${foldText ? "Show more" : "Show less"}</button>` : ""}
        ${translateAffordanceHtml(post)}
        ${pollCardHtml(post)}
        ${quotedHtml}
        <div class="kaposts-actions">
          ${/* The focused post of a thread has no reply button of its own: its reply box is pinned
               under the thread (iOS threadCell onComment: isRoot ? nil). */ ""}
          ${showReply ? `<button class="kaposts-action" type="button" ${replyInline ? `data-kaposts-reply-to="${pid}"` : `data-kaposts-open="${pid}"`} title="${replyInline ? "Reply" : "Replies"}" aria-label="${replyInline ? "Reply to this post" : "Open replies"}">
            ${ICONS.comment}${commentCount > 0 ? `<span>${commentCount}</span>` : ""}
          </button>` : ""}
          ${pendingActionButtonHtml(`like:${post.id}`) ?? `<button class="kaposts-action${post.likedByMe ? " active-like" : ""}" type="button" data-kaposts-like="${pid}" title="Like">
            ${ICONS.like}${(Number(post.likes) || 0) > 0 ? `<span>${Number(post.likes) || 0}</span>` : ""}
          </button>`}
          ${pendingActionButtonHtml(`dislike:${post.id}`) ?? `<button class="kaposts-action${post.dislikedByMe ? " active-dislike" : ""}" type="button" data-kaposts-dislike="${pid}" title="Dislike">
            ${ICONS.dislike}${(Number(post.dislikes) || 0) > 0 ? `<span>${Number(post.dislikes) || 0}</span>` : ""}
          </button>`}
          ${pendingActionButtonHtml(`repost:${post.id}`) ?? `<button class="kaposts-action${post.repostedByMe ? " active-repost" : ""}" type="button" data-kaposts-repost="${pid}" title="Repost">
            ${ICONS.repost}${(Number(post.reposts) || 0) > 0 ? `<span>${Number(post.reposts) || 0}</span>` : ""}
          </button>`}
          <button class="kaposts-action${post.bookmarkedByMe ? " active-bookmark" : ""}" type="button" data-kaposts-bookmark="${pid}" title="${post.bookmarkedByMe ? "Remove Bookmark" : "Bookmark"}">${ICONS.bookmark}</button>
          ${post.remoteId ? `<button class="kaposts-action" type="button" data-kaposts-share="${pid}" title="Copy share link">${ICONS.share}</button>` : ""}
          ${isMine ? "" : `<button class="kaposts-action kaposts-tip" type="button" data-kaposts-tip="${pid}" title="Send a Kaspa tip"><img class="kaposts-tip-logo" src="${kaspaLogoUrl}" alt="" aria-hidden="true" /><span>Tip</span></button>`}
          ${/* How many times it was tipped, the way likes show theirs (iOS 0f241ce): a gray number
               against the Tip button on someone else's post, the Kaspa mark and the count on your own.
               A tap lists who tipped. */ ""}
          ${tips > 0 && post.remoteId ? `<button class="kaposts-action kaposts-tips-count${isMine ? " own" : ""}" type="button" data-kaposts-tippers="${pid}" aria-label="Who tipped this post" title="Who tipped this post">${isMine ? `<img class="kaposts-tip-logo" src="${kaspaLogoUrl}" alt="" aria-hidden="true" />` : ""}<span>${tips}</span></button>` : ""}
          ${deliveryHtml}
        </div>
        <div class="kaposts-cell-foot"><span class="kaposts-cell-stamp">${deps.escapeHtml(postTimestamp(post.timestamp))}${post.editedAt ? ` <span class="kaposts-cell-edited" title="Edited">· edited</span>` : ""}</span></div>
        ${!inThread && isThreadRootPost(post) ? `<button class="kaposts-view-thread" type="button" data-kaposts-open="${pid}">⤷ View thread</button>` : ""}
      </div>
    </article>`;
}

// A post's popularity score. Every interaction counts - a post people argue with is popular in
// the same sense a post people like is - including comments, which the cell already shows.
function engagementScore(post) {
  const comments = Math.max(post.remoteReplyCount || 0, (post.comments || []).length);
  return (post.likes || 0) + (post.reposts || 0) + (post.dislikes || 0) + comments;
}

// iOS emptyStateIcon/Title/Body per feed tab.
const FEED_EMPTY_STATES = {
  following: {
    icon: `<svg class="kaposts-empty-icon" viewBox="0 0 24 24"><path d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"/></svg>`,
    title: "Nothing from people you follow",
    body: "Posts from accounts you follow will show up here.",
  },
  feed: {
    icon: `<svg class="kaposts-empty-icon" viewBox="0 0 24 24"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"/></svg>`,
    title: "No posts yet",
    body: "Be the first - tap the pencil to write a post.",
  },
  popular: {
    icon: `<svg class="kaposts-empty-icon" viewBox="0 0 24 24"><path d="M15.362 5.214A8.252 8.252 0 0 1 12 21 8.25 8.25 0 0 1 6.038 7.047 8.287 8.287 0 0 0 9 9.601a8.983 8.983 0 0 1 3.361-6.867 8.21 8.21 0 0 0 3 2.48Z"/><path d="M12 18a3.75 3.75 0 0 0 .495-7.468 5.99 5.99 0 0 0-1.925 3.547 5.975 5.975 0 0 1-2.133-1.001A3.75 3.75 0 0 0 12 18Z"/></svg>`,
    title: "Nothing trending yet",
    body: "The most liked, reposted and talked-about posts will show up here.",
  },
};

/**
 * Full repaint. Keeps the scroll position by default — a like or a countdown tick calls
 * renderAll(), and with hundreds of paged-in rows a rewrite that jumped to the top would be
 * unusable. Only page-one loads pass resetScroll.
 */
function renderFeed({ resetScroll = false } = {}) {
  if (!feedEl) return;
  const scroller = kapostsScrollEl();
  const previousTop = scroller?.scrollTop || 0;
  const posts = visibleFeedPosts();
  if (posts.length === 0) {
    renderedFeedIds = new Set();
    // The tab's empty state, always (iOS feedContent): while page one loads a spinner sits under
    // it. Everything fetched so far was filtered away (all muted, or - on Following - none of it
    // from accounts you follow) while the server still has older pages: no auto-sentinel here,
    // with nothing on screen it would walk the whole history unattended, so this stays a tap.
    const loading = Boolean(feedPager?.loading) || feedLoading;
    const canLoadOlder = feedPager && !loading && feedPager.hasMore && feedPager.cursor;
    clearPagerSentinel("feed");
    feedEl.innerHTML = `
      <div class="no-results-card kaposts-empty">
        ${FEED_EMPTY_STATES[activeFeedTab].icon}
        <strong>${FEED_EMPTY_STATES[activeFeedTab].title}</strong>
        <span>${FEED_EMPTY_STATES[activeFeedTab].body}</span>
      </div>
      ${canLoadOlder ? `<button class="kaposts-load-older" type="button" data-kaposts-load-older>Load older posts</button>` : ""}
      ${loading ? `<div class="kaposts-empty-loading"><span class="kaposts-pager-spinner" aria-label="Loading"></span></div>` : ""}`;
  } else {
    renderedFeedIds = new Set(posts.map((post) => post.id));
    feedEl.innerHTML = newPostsPillHtml() + posts.map((post) => postCellHtml(post)).join("");
    // The footer: "Loading more..." while a page (page one included) is in flight, the failure
    // with "Tap to retry", or the sentinel that pulls the next page (iOS KaPostsLoadMoreFooter).
    mountPagerSentinel("feed", feedEl, feedPager, loadMoreFeed);
  }
  if (scroller) scroller.scrollTop = resetScroll ? 0 : previousTop;
  // Thread-root probes for commented posts (throttled, once per post per session) so the
  // "View thread" link can appear on other people's threads too.
  probeThreadRoots(posts);
}

/**
 * Appends only the rows the DOM does not have yet, above the sentinel — never a rebuild, so
 * the scroll position is untouched. Returns how many rows actually landed (0 when the whole
 * page was muted/blocked/unfollowed away, which is what drives the shrinkage loop).
 */
function appendFeedRows() {
  if (!feedEl) return 0;
  const posts = visibleFeedPosts().filter((post) => !renderedFeedIds.has(post.id));
  if (posts.length === 0) return 0;
  if (renderedFeedIds.size === 0) { renderFeed(); return posts.length; } // replaces the empty card
  // Popular sorts client-side over the loaded window; a batch is ranked within itself and
  // parked below what is already on screen (a refresh re-sorts everything).
  const ordered = activeFeedTab === "popular"
    ? [...posts].sort((a, b) => engagementScore(b) - engagementScore(a))
    : posts;
  const html = ordered.map((post) => postCellHtml(post)).join("");
  const sentinel = feedEl.querySelector('[data-kaposts-sentinel="feed"]');
  if (sentinel) sentinel.insertAdjacentHTML("beforebegin", html);
  else feedEl.insertAdjacentHTML("beforeend", html);
  for (const post of ordered) renderedFeedIds.add(post.id);
  return ordered.length;
}

/**
 * The feed, the thread and the panel are `flex: 1` SIBLINGS in one scroller, so any two of
 * them visible at once produce a stacked split view with two back headers. Exactly one wins,
 * decided here in one place (both renderThread and renderPanel route through it):
 *
 *  - a panel opened from the rail/feed wins whenever no thread is open;
 *  - a thread opened FROM a panel (profile row, bookmark) takes the viewport over, and the
 *    panel returns when the thread stack empties;
 *  - a panel opened from INSIDE a thread (Post Activity, a poster's profile) is presented
 *    OVER the thread — `panelOverThread` — and its Back returns to the thread, mirroring the
 *    nested sheets iOS presents from the thread's own hierarchy.
 */
function syncSurfaces(threadPost) {
  const hasThread = Boolean(threadPost);
  const showPanel = Boolean(activePanel) && (!hasThread || panelOverThread);
  const showThread = hasThread && !showPanel;
  const showFeed = !showPanel && !showThread;
  if (threadEl) threadEl.hidden = !showThread;
  if (panelEl) panelEl.hidden = !showPanel;
  if (feedEl) feedEl.hidden = !showFeed;
  if (tabsEl) tabsEl.hidden = !showFeed;
}

function currentThreadPost() {
  const topId = threadStack[threadStack.length - 1];
  return topId ? findPost(topId) : null;
}

function syncReplyBarGate() {
  const replyBar = replyInput?.closest(".kaposts-reply-bar");
  if (!replyBar) return;
  const gated = Boolean(deps?.isChattingBalanceZero?.());
  replyBar.classList.toggle("gated", gated);
  if (replyInput) replyInput.readOnly = gated;
}

// Inline "View N replies" chains each own a footer sentinel; their keys are tracked so a rebuild
// of the replies list can drop the observers of the old ones.
const inlinePagerKeys = new Set();

function renderThread() {
  syncReplyBarGate();
  const post = currentThreadPost();
  // A thread whose post cannot be resolved says so instead of falling back to the feed (iOS
  // postDetailSheet's "This post could not be loaded").
  const missing = !post && threadStack.length > 0;
  const showThread = Boolean(post) || missing;
  syncSurfaces(post || (missing ? { missing: true } : null));
  if (!post) clearPagerSentinel("thread");
  const replyBar = replyInput?.closest(".kaposts-reply-bar");
  if (replyBar) replyBar.hidden = !post;
  if (missing && threadRootEl) {
    threadRootEl.innerHTML = `
      <div class="no-results-card kaposts-empty kaposts-thread-missing">
        <svg class="kaposts-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"/></svg>
        <strong>This post could not be loaded</strong>
        <span>It may have been removed, or the network may be unreachable.</span>
      </div>`;
    if (threadRepliesEl) threadRepliesEl.innerHTML = "";
  }
  if (!showThread || !post || !threadRootEl) return;
  const scroller = kapostsScrollEl();
  const previousTop = scroller?.scrollTop || 0;
  // Thread segments are the author's own continuation - they render as a connected section
  // under the root and are excluded from the replies list (segment 2 IS a direct reply).
  const chain = threadChains.get(post.id) || [];
  const chainIds = new Set(chain.map((segment) => segment.remoteId).filter(Boolean));
  const comments = post.comments.filter((c) => !isHiddenAuthor(c.posterAddress)
    && !(c.remoteId && chainIds.has(c.remoteId)));
  if (threadRootEl) {
    // Ancestors render as the posts they are - full cells, every action live - connected to the
    // post below by a rail down the avatar column, the way X draws a conversation. Tapping one
    // opens it.
    // The exact chain from get-thread once it has answered; until then (and for a session post,
    // which is all it has) the in-memory walk (iOS ancestorChain).
    const fetched = fetchedAncestors.get(post.remoteId) || [];
    const ancestors = fetched.length ? fetched : walkAncestorChain(post);
    const ancestorsHtml = ancestors.length
      ? `<div class="kaposts-ancestors">${ancestors
          .map((entry) => `<div class="kaposts-ancestor" data-kaposts-ancestor="${deps.escapeHtml(String(entry.id))}">${postCellHtml(entry, { inThread: true, replyInline: true, truncates: true })}</div>`)
          .join("")}</div>`
      : "";
    // "Thread" is what an author calls their OWN continuation; once the chain carries other
    // people's replies it is a conversation, and calling it a thread credits them to the author.
    const isSelfThread = chain.every((segment) => segment.posterAddress === post.posterAddress);
    threadRootEl.innerHTML = ancestorsHtml
      + postCellHtml(post, { inThread: true, isRoot: true, replyInline: true, showReply: false })
      + (chain.length ? `
      <div class="kaposts-thread-chain">
        <div class="kaposts-thread-chain-header">${isSelfThread ? "Thread" : "Conversation"} · ${chain.length + 1} posts</div>
        ${chain.map((segment) => `<div class="kaposts-thread-chain-item">${postCellHtml(segment, { inThread: true, replyInline: true })}</div>`).join("")}
      </div>` : "");
  }
  if (threadRepliesEl) {
    // An unbranched exchange is rendered in full ABOVE, and its members are filtered out of
    // this list - so "no comments yet" would contradict the replies the reader can already see.
    const emptyCommentsHtml = comments.length ? "" : `
      <p class="kaposts-comments-empty">${chain.length ? "Every reply is in the conversation above." : "No comments yet - be the first to reply."}</p>`;
    for (const key of inlinePagerKeys) clearPagerSentinel(key);
    inlinePagerKeys.clear();
    threadRepliesEl.innerHTML = `
      <div class="kaposts-comments-header">${comments.length ? `Comments (${comments.length})` : "Comments"}</div>
      ${emptyCommentsHtml}
      <div class="kaposts-thread-replies">
        ${comments.map((comment) => {
          const nested = (comment.comments || []).filter((c) => !isHiddenAuthor(c.posterAddress));
          const expanded = expandedCommentIds.has(comment.id);
          const inlinePager = threadPagers.get(comment.id);
          const hasReplies = (comment.remoteReplyCount || 0) > 0 || nested.length > 0;
          // Expands in place rather than opening its own thread. The empty case says which it is
          // from the chain's page state - still fetching, failed (with the reason and Retry), or
          // answered with nothing - since a count that is a whole subtree while get-replies returns
          // direct replies only would otherwise spin forever (iOS threadRepliesSection). With
          // replies on screen the chain pages on through its own footer.
          const nestedHtml = !expanded ? "" : `
            <div class="kaposts-inline-replies" data-kaposts-inline-replies="${deps.escapeHtml(String(comment.id))}">
              ${nested.length
                ? nested.map((reply) => `<div class="kaposts-thread-reply">${postCellHtml(reply, { inThread: true, replyInline: true })}</div>`).join("")
                : inlinePager?.loading
                  ? `<p class="kaposts-inline-note with-spinner"><span class="kaposts-pager-spinner" aria-hidden="true"></span><span>Loading replies...</span></p>`
                  : inlinePager?.error
                    ? `<p class="kaposts-inline-note">${deps.escapeHtml(inlinePager.error)} <button type="button" class="kaposts-inline-retry" data-kaposts-retry-replies="${deps.escapeHtml(String(comment.id))}">Retry</button></p>`
                    : `<p class="kaposts-inline-note">No replies</p>`}
            </div>`;
          return `
          <div class="kaposts-thread-reply">
            ${postCellHtml(comment, { inThread: true, replyInline: true })}
            ${hasReplies ? `<button class="kaposts-show-more" type="button" data-kaposts-expand-replies="${deps.escapeHtml(String(comment.id))}">${expanded ? "Hide replies" : `View ${Math.max(comment.remoteReplyCount || 0, nested.length)} ${Math.max(comment.remoteReplyCount || 0, nested.length) === 1 ? "reply" : "replies"}`}</button>` : ""}
            ${nestedHtml}
          </div>`;
        }).join("")}
      </div>`;
    const pager = threadPagers.get(post.id);
    mountPagerSentinel("thread", threadRepliesEl, pager, () => loadMoreThreadReplies(post.id));
    for (const comment of comments) {
      if (!expandedCommentIds.has(comment.id)) continue;
      const nested = (comment.comments || []).filter((c) => !isHiddenAuthor(c.posterAddress));
      const inlinePager = threadPagers.get(comment.id);
      if (!nested.length || !inlinePager) continue;
      const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(comment.id)) : String(comment.id);
      const holder = threadRepliesEl.querySelector(`[data-kaposts-inline-replies="${escaped}"]`);
      const key = `inline-${comment.id}`;
      inlinePagerKeys.add(key);
      mountPagerSentinel(key, holder, inlinePager, () => loadMoreCommentReplies(comment.id));
    }
    // The replies list is rebuilt whole (comment counts and countdowns live in every row),
    // so hold the scroll position explicitly or paging in older replies would jump the view.
    if (scroller) scroller.scrollTop = previousTop;
  }
  // Runs AFTER the scroll restore above, which would otherwise undo the landing scroll.
  applyPendingThreadScroll();
  applyThreadHighlight();
}

/** The rendered cell for a txid inside the open thread (replies first, then root/chain). */
function threadCellElementFor(remoteId) {
  if (!remoteId || !threadEl) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(remoteId) : remoteId;
  const selector = `[data-kaposts-remote-id="${escaped}"]`;
  return threadRepliesEl?.querySelector(selector) || threadEl.querySelector(selector);
}

/**
 * Reply-notification landing: the parent's thread is open, so as soon as the reply itself is
 * in the comment list, bring it into view and flash it. Stays pending until the reply lands
 * (openThread's reply fetch re-renders), and is cleared by the next openThread either way.
 */
function applyPendingThreadScroll() {
  // Measuring a hidden thread (a panel is presented over it) yields zero-sized rects — the
  // landing waits until the thread is the surface on screen again.
  if (!pendingThreadScrollRemoteId || !threadEl || threadEl.hidden) return;
  const target = threadCellElementFor(pendingThreadScrollRemoteId);
  const scroller = kapostsScrollEl();
  if (!target || !scroller) return;
  threadHighlightRemoteId = pendingThreadScrollRemoteId;
  pendingThreadScrollRemoteId = null;
  requestAnimationFrame(() => {
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const centering = Math.max(0, (scroller.clientHeight - targetRect.height) / 2);
    scroller.scrollTop += targetRect.top - scrollerRect.top - centering;
    applyThreadHighlight();
  });
  window.clearTimeout(threadHighlightTimer);
  threadHighlightTimer = window.setTimeout(() => {
    threadHighlightRemoteId = null;
    threadEl?.querySelectorAll(".kaposts-cell-highlight")
      .forEach((el) => el.classList.remove("kaposts-cell-highlight"));
  }, 2600);
}

/** Re-applies the landing flash after a re-render rebuilt the replies list from scratch. */
function applyThreadHighlight() {
  if (!threadHighlightRemoteId) return;
  threadCellElementFor(threadHighlightRemoteId)?.classList.add("kaposts-cell-highlight");
}

/** Toast label per pending-action key: EVERY interaction gets a visible undo toast. */
function toastLabelFor(key) {
  if (key.startsWith("post:quote")) return "Posting quote";
  if (key.startsWith("post:")) return "Posting";
  if (key.startsWith("like:")) return "Liking";
  if (key.startsWith("dislike:")) return "Disliking";
  if (key.startsWith("repost:")) return "Reposting";
  if (key.startsWith("comment:")) return "Posting comment";
  return "Posting";
}

const actionToasts = [];
/** The feed's action toast (check, text, "View" on the explorer), for the app's instant tip
 *  (iOS KaPostsView showActionToast "Tipped ... to ..."). */
export function showKaPostsActionToast(text, txId = null) { showActionToast(text, txId); }
function showActionToast(text, txId = null) {
  const toast = { text, txId };
  actionToasts.push(toast);
  renderToasts();
  setTimeout(() => {
    const index = actionToasts.indexOf(toast);
    if (index >= 0) actionToasts.splice(index, 1);
    renderToasts();
  }, 4000);
}

function renderToasts() {
  if (!toastsEl) return;
  const parts = [];
  for (const toast of actionToasts) {
    parts.push(`
      <div class="kaposts-toast kaposts-toast-action">
        <svg class="kaposts-toast-check" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m7.75 12.25 2.75 2.75 5.75-6"/></svg>
        <span>${deps.escapeHtml(toast.text)}</span>
        ${toast.txId && deps.explorerTxUrl ? `<a class="kaposts-toast-view" href="${deps.escapeHtml(deps.explorerTxUrl(toast.txId))}" target="_blank" rel="noopener">View</a>` : ""}
      </div>`);
  }
  for (const [key, pending] of pendingActions) {
    const seconds = Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000));
    parts.push(`
      <div class="kaposts-toast">
        <span>${deps.escapeHtml(pending.label || toastLabelFor(key))} in <span class="kaposts-countdown" data-kaposts-countdown="${deps.escapeHtml(key)}">${seconds}</span>s</span>
        <button type="button" data-kaposts-undo="${deps.escapeHtml(key)}">Undo</button>
      </div>`);
  }
  toastsEl.innerHTML = parts.join("");
}

function formatRelativeTime(timestampMs) {
  const delta = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 7 * 86400) return `${Math.floor(delta / 86400)}d`;
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function makeLocalPost(text, { quotedOf = null, poll = null } = {}) {
  return {
    poll,
    id: nowId(),
    remoteId: null,
    posterPubkey: safeRequesterPubkey(),
    posterAddress: deps.engine.address || "",
    text,
    timestamp: Date.now(),
    likes: 0, dislikes: 0, reposts: 0,
    likedByMe: false, dislikedByMe: false, repostedByMe: false,
    remoteReplyCount: 0,
    comments: [],
    quoted: quotedOf
      ? { remoteId: quotedOf.remoteId, text: quotedOf.text, posterAddress: quotedOf.posterAddress, posterPubkey: quotedOf.posterPubkey || null }
      : null,
    parentRemoteId: null,
    delivery: "pending",
  };
}

function safeRequesterPubkey() {
  try { return requesterPubkeyFor(deps.engine); } catch { return null; }
}

function schedulePost(text) {
  const post = makeLocalPost(text);
  localPosts.unshift(post);
  const key = `post:${post.id}`;
  scheduleUndoable(key, async () => {
    renderToasts();
    try {
      const txid = await submitKaPost({ engine: deps.engine, text, mentionedPubkeys: await mentionedPubkeysFor(text) });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      // The red Retry on the card is the whole report (iOS schedulePost): no toast.
      mutatePost(post.id, (p) => { p.delivery = "failed"; p.failureReason = error?.message || String(error); });
      deps.appendEngineLog?.(`KaPost submit failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
    restoreComposerDraft(text);
  });
}

// A poll (iOS 3b1aecf): the question is the post; the options and closing time go out with it,
// behind the usual 5 s undo. The card keeps its own numbers until the feed carries the
// indexer's.
function schedulePoll(question, options, lengthMs) {
  const closesAt = pollClosesAt(lengthMs); // XP-008: the 7-day option closes 5 min short
  const poll = { options, counts: options.map(() => 0), total: 0, closesAt, myVote: null };
  const post = makeLocalPost(question, { poll });
  // How long the author chose to keep it open (iOS df4aba6 KaPostPoll.length): a retry reopens it
  // for exactly this long from the retry. Re-deriving it as closesAt minus the post's time grew it
  // on every retry - the retry moves closesAt, the post's time stays.
  poll.length = closesAt - post.timestamp;
  localPosts.unshift(post);
  scheduleUndoable(`post:${post.id}`, async () => {
    renderToasts();
    try {
      const txid = await submitKaPoll({ engine: deps.engine, question, options, closesAtMs: closesAt, mentionedPubkeys: await mentionedPubkeysFor(question) });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; p.failureReason = error?.message || String(error); });
      deps.appendEngineLog?.(`KaPost poll failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
    restoreComposerDraft(question, { pollOptions: options });
  }, "Posting poll");
}

// A vote is one transaction behind the usual 5 s undo (iOS votePoll). Nothing changes on the card
// while it is held - Undo has nothing to put back - and the choice lands once the transaction is
// on the network, with the usual confirmation toast; the indexer's numbers follow.
function scheduleVote(post, optionIndex) {
  const closed = Boolean(post.poll?.closesAt) && Date.now() >= post.poll.closesAt;
  if (!post.remoteId || !post.poll || closed || optionIndex >= post.poll.options.length) return;
  scheduleUndoable(`vote:${post.id}`, async () => {
    try {
      const txid = await submitKaPollVote({ engine: deps.engine, pollId: post.remoteId, optionIndex });
      mutatePost(post.id, (p) => {
        if (!p.poll) return;
        if (p.poll.myVote != null && p.poll.counts[p.poll.myVote] != null) p.poll.counts[p.poll.myVote] = Math.max(0, p.poll.counts[p.poll.myVote] - 1);
        else p.poll.total += 1;
        p.poll.counts[optionIndex] = (p.poll.counts[optionIndex] || 0) + 1;
        p.poll.myVote = optionIndex;
      });
      renderAll();
      showActionToast("Vote posted to the network", txid);
      refreshPollNumbers(post);
    } catch (error) {
      deps.appendEngineLog?.(`KaPost vote failed: ${error.message}`);
      renderAll();
    }
  }, null, "Voting");
}

async function refreshPollNumbers(post) {
  if (!post.remoteId) return;
  try {
    const fresh = mapRemotePoll(await fetchPoll({ engine: deps.engine, postId: post.remoteId }));
    // Right after a vote the indexer may not have seen the transaction yet and answers with no
    // vote of ours: keep the optimistic state rather than re-opening the options (a second
    // vote would be a second fee). The feed carries the settled numbers next time.
    if (fresh) { mutatePost(post.id, (p) => { if (fresh.myVote == null && p.poll?.myVote != null) return; p.poll = fresh; }); renderAll(); }
  } catch { /* the feed carries the numbers next time */ }
}

// --- X-style thread reading ---------------------------------------------------
// remoteId -> "its replies include one by the author" (thread root). false is cached too, so a
// post is probed at most once per session.
const threadRootProbe = new Map();
// root post local id -> [segment posts] (the author's own continuation, in order).
const threadChains = new Map();

function isThreadRootPost(post) {
  if (post?.isThreadRoot) return true;
  return Boolean(post?.remoteId && threadRootProbe.get(post.remoteId));
}

// Cheap feed probe, a few posts per render pass: first reply page, any self-authored reply =
// thread root (X's own "Show this thread" heuristic).
function probeThreadRoots(posts) {
  const candidates = (posts || []).filter((p) => p.remoteId
    && !threadRootProbe.has(p.remoteId)
    && ((p.remoteReplyCount || 0) > 0 || (p.comments || []).length > 0)).slice(0, 10);
  if (!candidates.length) return;
  (async () => {
    let found = false;
    for (const post of candidates) {
      if (threadRootProbe.has(post.remoteId)) continue;
      threadRootProbe.set(post.remoteId, false); // claim: never probe twice
      try {
        const page = await fetchReplies({ engine: deps.engine, postId: post.remoteId, limit: 10 });
        const isThread = (page?.posts || []).some((reply) => {
          const mapped = mapRemotePost(reply);
          return mapped && mapped.posterAddress === post.posterAddress;
        });
        if (isThread) { threadRootProbe.set(post.remoteId, true); found = true; }
      } catch { /* stays false */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (found) renderFeed();
  })();
}

// Walks the author's self-reply chain from an opened root (root <- seg2 <- seg3 ... by the
// same author), fetching each next link. Capped defensively.
async function loadSelfThreadChain(post) {
  if (!post?.remoteId) return;
  const chain = [];
  let candidates = (post.comments || [])
    .filter((c) => c.remoteId && !isHiddenAuthor(c.posterAddress))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  let hops = 0;
  while (hops < 25) {
    // An UNBRANCHED continuation is the conversation, whoever wrote it: a back-and-forth between
    // two people is one thread to read, and following only the root author's replies left every
    // other message behind a tap - one tap down per message, and as many back to leave.
    //
    // With SEVERAL replies there is a real branch, and picking one would hide the others, so that
    // case keeps the old rule (the author's own continuation, which they wrote deliberately) and
    // everything else stays in the replies list below.
    const current = candidates.length === 1
      ? candidates[0]
      : candidates.filter((reply) => reply.posterAddress === post.posterAddress)[0] || null;
    if (!current || !current.remoteId) break;
    chain.push(current);
    hops += 1;
    let page = null;
    try { page = await fetchReplies({ engine: deps.engine, postId: current.remoteId, limit: 25 }); }
    catch { break; }
    candidates = (page?.posts || []).map(mapRemotePost).filter(Boolean)
      .filter((reply) => reply.remoteId && !isHiddenAuthor(reply.posterAddress))
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }
  threadChains.set(post.id, chain);
  if (chain.length) threadRootProbe.set(post.remoteId, true);
}

// --- X-style thread posting --------------------------------------------------
// Unposted work per in-flight/failed thread, keyed by the root's LOCAL id: rootText until the
// root posts, the remaining segments, and the last landed txid. Kept until every segment lands
// so Retry RESUMES the chain from the first unposted segment (never duplicates).
const threadRemainders = new Map();

// Consecutive payload txs spend each other's change before the node indexes it (~1s blocks) -
// retry a few times with settle delays before giving up.
async function submitWithUtxoRetry(op) {
  let attempt = 0;
  for (;;) {
    try { return await op(); }
    catch (error) {
      attempt += 1;
      if (attempt > 4) throw error;
      deps.appendEngineLog?.(`KaPost thread segment retry ${attempt}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

// First segment = top-level post, each following segment = reply to the PREVIOUS one. Segments
// submit sequentially once the countdown runs out (each one needs the previous txid), and the
// optimistic root carries pending/sent/failed for the whole chain.
//
// Same 5s hold as a single post. A thread used to submit the instant it was composed - the one
// compose action with no undo window at all, and the one where a mistake costs the most to fix,
// since every segment is its own transaction.
function scheduleThread(segments) {
  if (!segments.length) return;
  if (segments.length === 1) { schedulePost(segments[0]); return; }
  const post = makeLocalPost(segments[0]);
  post.isThreadRoot = true;
  localPosts.unshift(post);
  const key = `post:${post.id}`;
  scheduleUndoable(key, () => {
    // The remainder ledger is written HERE rather than up front, on purpose: it is what Retry
    // resumes from, so an undone thread must leave nothing behind for a later retry to pick up.
    threadRemainders.set(post.id, { rootText: segments[0], segments: segments.slice(1), parentTxId: null });
    continueThread(post.id);
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
    // Back the way the composer held it: every segment but the last is a stacked segment, and the
    // last is whatever was in the editor when Post All was pressed.
    restoreComposerDraft(segments[segments.length - 1], { segments: segments.slice(0, -1) });
  }, "Posting thread");
}

async function continueThread(localId) {
  const state = threadRemainders.get(localId);
  if (!state) return;
  mutatePost(localId, (p) => { p.delivery = "pending"; });
  renderAll();
  try {
    if (state.rootText != null) {
      const rootText = state.rootText;
      const txid = await submitWithUtxoRetry(async () =>
        submitKaPost({ engine: deps.engine, text: rootText, mentionedPubkeys: await mentionedPubkeysFor(rootText) }));
      mutatePost(localId, (p) => { p.remoteId = txid; });
      state.rootText = null;
      state.parentTxId = txid;
    }
    const myPubkey = safeRequesterPubkey();
    while (state.segments.length && state.parentTxId) {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // let the previous change settle
      const segment = state.segments[0];
      const txid = await submitWithUtxoRetry(async () =>
        submitKaPostReply({
          engine: deps.engine, text: segment, postId: state.parentTxId, parentAuthorPubkey: myPubkey,
          mentionedPubkeys: await mentionedPubkeysFor(segment),
        }));
      state.segments.shift();
      state.parentTxId = txid;
    }
    threadRemainders.delete(localId);
    mutatePost(localId, (p) => { p.delivery = "sent"; });
  } catch (error) {
    mutatePost(localId, (p) => { p.delivery = "failed"; p.failureReason = error?.message || String(error); });
    deps.appendEngineLog?.(`KaPost thread submit failed (resumable): ${error.message}`);
  }
  renderAll();
}

function scheduleQuote(target, text) {
  const post = makeLocalPost(text, { quotedOf: target });
  localPosts.unshift(post);
  const key = `post:quote-${post.id}`;
  scheduleUndoable(key, async () => {
    renderToasts();
    mutatePost(target.id, (p) => { if (!p.repostedByMe) { p.repostedByMe = true; p.reposts += 1; } });
    try {
      const txid = await submitKaPostQuote({
        engine: deps.engine, text, contentId: target.remoteId, quotedAuthorPubkey: target.posterPubkey,
      });
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
      showActionToast("Quote posted to the network", txid);
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; p.failureReason = error?.message || String(error); });
      deps.appendEngineLog?.(`KaPost quote failed: ${error.message}`);
    }
    renderAll();
  }, () => {
    localPosts = localPosts.filter((p) => p.id !== post.id);
    restoreComposerDraft(text, { quoted: target });
  });
}

/**
 * Same countdown-then-act rule as toggleVote (iOS handleRepostAction): nothing changes while the
 * repost is held - the button turns into the undo capsule - and the state lands with the
 * transaction once the countdown ends. Already reposted means the countdown ends in the fork's
 * `unquote` counter-action, which nets the repost out on the indexer (the chain keeps both
 * transactions) - iOS performUnrepost.
 */
function scheduleRepost(target) {
  const key = `repost:${target.id}`;
  if (pendingActions.has(key)) { cancelUndoable(key); return; }
  const wasReposted = (findPost(target.id) || target).repostedByMe === true;
  scheduleUndoable(key, async () => {
    mutatePost(target.id, (p) => {
      if (wasReposted && p.repostedByMe) { p.repostedByMe = false; p.reposts = Math.max(0, (p.reposts || 0) - 1); }
      else if (!wasReposted && !p.repostedByMe) { p.repostedByMe = true; p.reposts = (p.reposts || 0) + 1; }
    });
    renderAll();
    try {
      if (wasReposted) {
        const txid = await submitKaPostUnquote({ engine: deps.engine, contentId: target.remoteId });
        showActionToast("Repost removed on the network", txid);
      } else {
        const txid = await submitKaPostQuote({ engine: deps.engine, text: "", contentId: target.remoteId, quotedAuthorPubkey: target.posterPubkey });
        showActionToast("Repost posted to the network", txid);
      }
    } catch (error) {
      deps.appendEngineLog?.(`KaPost ${wasReposted ? "unrepost" : "repost"} failed: ${error.message}`);
    }
  }, null, wasReposted ? "Removing repost" : "Reposting");
}

function playVoteBurst(postId, kind) {
  const safeId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(String(postId)) : String(postId).replace(/["\\]/g, "\\$&");
  const selector = kind === "like" ? `[data-kaposts-like="${safeId}"]` : `[data-kaposts-dislike="${safeId}"]`;
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.remove("kaposts-burst");
    void button.offsetWidth; // restart the animation
    button.classList.add("kaposts-burst");
    if (kind === "like") spawnKaspaLogoBurst(button);
  });
}

/** iOS-style like celebration: a burst of little Kaspa logos flying out of the heart. */
function spawnKaspaLogoBurst(anchor) {
  const rect = anchor.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;
  const count = 7;
  for (let i = 0; i < count; i += 1) {
    const particle = document.createElement("img");
    particle.src = kaspaLogoUrl;
    particle.alt = "";
    particle.className = "kaposts-logo-particle";
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const distance = 34 + Math.random() * 26;
    particle.style.left = `${originX}px`;
    particle.style.top = `${originY}px`;
    particle.style.setProperty("--burst-x", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--burst-y", `${Math.sin(angle) * distance - 14}px`);
    particle.style.setProperty("--burst-rot", `${(Math.random() - 0.5) * 240}deg`);
    document.body.appendChild(particle);
    particle.addEventListener("animationend", () => particle.remove());
    // Safety net in case animationend never fires (tab hidden etc.).
    setTimeout(() => particle.remove(), 1200);
  }
}

/**
 * Like/dislike, as iOS toggleLike/toggleDislike: the tap holds the action for the 5 s undo and the
 * button becomes the undo capsule - nothing changes yet, so Undo (or a click on the capsule) has
 * nothing to put back. When the countdown ends the state lands on every copy of the post (filled
 * icon, count, the Kaspa-logo burst for a like) and the vote goes on chain. Removing a like from a
 * post that never reached the network is local and instant.
 */
function toggleVote(post, kind) {
  const flag = kind === "like" ? "likedByMe" : "dislikedByMe";
  const key = `${kind}:${post.id}`;
  if (pendingActions.has(key)) { cancelUndoable(key); return; }
  const current = findPost(post.id) || post;
  const wasSet = current[flag] === true;
  if (wasSet && !current.remoteId) { performVote(post, kind, wasSet); return; }
  scheduleUndoable(key, () => performVote(post, kind, wasSet), null, wasSet
    ? (kind === "like" ? "Removing like" : "Removing dislike")
    : (kind === "like" ? "Liking" : "Disliking"));
}

/** The like/dislike landing once its countdown ran out (iOS performLike / performDislike). */
function performVote(post, kind, wasSet) {
  const flag = kind === "like" ? "likedByMe" : "dislikedByMe";
  const other = kind === "like" ? "dislikedByMe" : "likedByMe";
  const count = kind === "like" ? "likes" : "dislikes";
  const otherCount = kind === "like" ? "dislikes" : "likes";
  if (post.remoteId && post.posterPubkey) {
    const vote = wasSet ? "unvote" : (kind === "like" ? "upvote" : "downvote");
    submitKaPostVote({ engine: deps.engine, postId: post.remoteId, vote, authorPubkey: post.posterPubkey })
      .then((txid) => showActionToast(`${kind === "like" ? "Like" : "Dislike"} ${wasSet ? "removed on" : "posted to"} the network`, txid))
      .catch((error) => deps.appendEngineLog?.(`KaPost vote failed: ${error.message}`));
  }
  mutatePost(post.id, (p) => {
    if (p[flag]) { p[flag] = false; p[count] = Math.max(0, (p[count] || 0) - 1); }
    else {
      p[flag] = true; p[count] = (p[count] || 0) + 1;
      if (p[other]) { p[other] = false; p[otherCount] = Math.max(0, (p[otherCount] || 0) - 1); }
    }
  });
  renderAll();
  // The burst plays when the like actually lands, not on the tap that armed it (iOS).
  if (!wasSet && kind === "like") playVoteBurst(post.id, kind);
}

function toggleFollow(post) {
  const address = post.posterAddress;
  if (!address || address === deps.engine.address) return;
  const willFollow = !prefs.following.includes(address);
  prefs.following = willFollow ? [...prefs.following, address] : prefs.following.filter((a) => a !== address);
  savePrefs();
  renderAll();
  if (!post.posterPubkey) return;
  submitKaPostFollow({ engine: deps.engine, follow: willFollow, followedPubkey: post.posterPubkey })
    .then((txid) => showActionToast(willFollow ? "Follow posted to the network" : "Unfollow posted to the network", txid))
    .catch((error) => deps.appendEngineLog?.(`KaPost follow failed: ${error.message}`));
}

/**
 * `scrollToRemoteId` is the reply-notification landing: this thread is the PARENT of the reply
 * that was tapped, so once the comment list actually contains that reply it is scrolled into
 * view and flashed. It is cleared on every normal open, so a stale target from an earlier
 * landing can never yank a later thread around (iOS pendingThreadScrollRemoteId).
 */
async function openThread(post, { scrollToRemoteId = null, ensureComment = null } = {}) {
  rememberFeedScroll();
  pendingThreadScrollRemoteId = scrollToRemoteId;
  // A thread always takes over the viewport: any panel it was opened from waits underneath.
  panelOverThread = false;
  threadStack.push(post.id);
  // The first page owns the footer while it loads ("Loading more..."), and a failure stays there
  // with "Tap to retry" (iOS loadThreadReplies(reset: true) through the thread's page state).
  const pager = post.remoteId ? makePager({ pageSize: PAGER_THREAD_PAGE_SIZE }) : null;
  if (pager) { pager.loading = true; threadPagers.set(post.id, pager); }
  renderThread();
  // The real chain above this post, not just the levels you happened to tap through.
  loadAncestorsFor(post);
  if (!post.remoteId) return;
  const generation = ++threadGeneration;
  try {
    const result = await fetchReplies({ engine: deps.engine, postId: post.remoteId, limit: PAGER_THREAD_PAGE_SIZE });
    if (generation !== threadGeneration) return;
    const replies = result.posts.map(mapRemotePost).filter(Boolean);
    seedPager(pager, result.posts, result.pagination);
    mutatePost(post.id, (p) => {
      // A reply of this session whose transaction is out but not yet indexed has a txid, so it
      // is not "local" - it is remembered by id and kept on top until the server returns it.
      const kept = p.comments.filter((c) => (!c.remoteId || sessionReplyIds.has(c.remoteId)) && !replies.some((r) => r.remoteId === c.remoteId));
      p.comments = [...kept, ...replies];
      // The reply a notification was tapped FOR: the indexer can lag the push by seconds, so a
      // brand-new reply is spliced in when the page came back without it (iOS openDetail
      // ensureComment) - the landing scroll then has something to land on.
      const ensuredId = ensureComment?.remoteId;
      if (ensuredId && !p.comments.some((c) => c.remoteId === ensuredId)) p.comments = [...p.comments, ensureComment];
    });
    if (ensureComment) resolvePosterIdentities([ensureComment.posterAddress], () => renderThread());
    renderThread();
    resolvePosterIdentities(replies.map((reply) => reply.posterAddress), () => {
      if (threadStack[threadStack.length - 1] === post.id) renderThread();
    });
    // Walk the author's own continuation (if any) so the Thread section can render.
    await loadSelfThreadChain(findPost(post.id) || post);
    if (generation === threadGeneration) renderThread();
  } catch (error) {
    if (generation !== threadGeneration) return;
    pager.loading = false;
    pager.error = userFacingError(error);
    deps.appendEngineLog?.(`KaPost replies load failed: ${error.message}`);
    renderThread();
  }
}

/** Sentinel hit under a thread's comments — pages older replies in. */
function loadMoreThreadReplies(postId) {
  const post = findPost(postId);
  const pager = threadPagers.get(postId);
  if (!post?.remoteId || !pager) return;
  const generation = threadGeneration;
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = await fetchReplies({ engine: deps.engine, postId: post.remoteId, limit, before });
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      let added = 0;
      mutatePost(postId, (p) => {
        const known = new Set(p.comments.map((c) => c.remoteId).filter(Boolean));
        const rows = mapped.filter((reply) => reply.remoteId && !known.has(reply.remoteId));
        p.comments = [...p.comments, ...rows];
        // mutatePost now visits EVERY copy of this post and each carries its own comments
        // array, so the copies can disagree on how many rows were new — the pager's shrinkage
        // loop wants the largest, not whichever copy happened to be visited last.
        added = Math.max(added, rows.filter((reply) => !isHiddenAuthor(reply.posterAddress)).length);
      });
      renderThread();
      resolvePosterIdentities(mapped.map((reply) => reply.posterAddress), () => {
        if (threadStack[threadStack.length - 1] === postId) renderThread();
      });
      return added;
    },
    isStale: () => generation !== threadGeneration || threadStack[threadStack.length - 1] !== postId,
    onUpdate: () => renderThread(),
  });
}

async function submitReply(parent, text) {
  const comment = makeLocalPost(text);
  // The indexer orders replies newest first, so the new one goes to the TOP straight away
  // rather than out of view at the bottom (iOS 7f82118).
  mutatePost(parent.id, (p) => { p.comments = [comment, ...p.comments]; });
  renderThread();
  // Same 5s undo window as every other interaction: the optimistic comment shows
  // immediately, the on-chain submit fires when the toast's countdown runs out,
  // and Undo removes the comment before anything hits the network.
  scheduleUndoable(`comment:${comment.id}`, async () => {
    try {
      const txid = await submitKaPostReply({
        engine: deps.engine, text, postId: parent.remoteId, parentAuthorPubkey: parent.posterPubkey,
        // @mentions work in comments exactly like in posts: resolved client-side to pubkeys.
        mentionedPubkeys: await mentionedPubkeysFor(text),
      });
      sessionReplyIds.add(txid);
      mutatePost(comment.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      mutatePost(comment.id, (p) => { p.delivery = "failed"; });
      deps.appendEngineLog?.(`KaPost reply failed: ${error.message}`);
    }
    renderThread();
  }, () => {
    mutatePost(parent.id, (p) => { p.comments = p.comments.filter((c) => c.id !== comment.id); });
    renderThread();
    // An undone reply reopens the reply composer with its parent attached and the words still in
    // it, wherever it was written - the pinned box or the composer (iOS restoreDraft).
    openComposer(null, { replyTarget: parent });
    if (composerInput && !composerEl.hidden) {
      composerInput.value = text;
      composerInput.dispatchEvent(new Event("input", { bubbles: true }));
      composerInput.focus();
    }
  });
}

function retryPost(post) {
  // A failed THREAD resumes its remaining chain instead of re-posting just the root.
  if (threadRemainders.has(post.id)) {
    continueThread(post.id);
    return;
  }
  mutatePost(post.id, (p) => { p.delivery = "pending"; });
  renderAll();
  // A failed REPLY goes out again as a reply to the post it answers (iOS retryPost resolves the
  // parent); re-sending it as a top-level post would put a stray answer in the feed.
  const parent = findParentOf(post.id);
  (async () => {
    try {
      let txid;
      if (parent) {
        if (!parent.remoteId) throw new Error("The post this replies to is not on the network yet.");
        txid = await submitKaPostReply({
          engine: deps.engine, text: post.text, postId: parent.remoteId, parentAuthorPubkey: parent.posterPubkey,
          mentionedPubkeys: await mentionedPubkeysFor(post.text),
        });
        sessionReplyIds.add(txid);
      } else if (post.quoted) {
        // A failed quote goes out again as the quote it was, never as plain text (iOS f28f1dc).
        if (!post.quoted.remoteId || !post.quoted.posterPubkey) throw new Error("The quoted post can't be found to quote it again.");
        txid = await submitKaPostQuote({ engine: deps.engine, text: post.text, contentId: post.quoted.remoteId, quotedAuthorPubkey: post.quoted.posterPubkey });
      } else if (post.poll) {
        // And a failed poll as the poll: its options, and its full length again from now, so a
        // late retry never puts an already-closed poll on chain (iOS IOS-093). The length is the
        // one chosen at compose time (iOS df4aba6), so a second retry is not longer than the first;
        // a poll without one (read from the network) keeps the old derivation.
        const chosen = Number(post.poll.length);
        const length = Math.max(Number.isFinite(chosen) && chosen > 0 ? chosen : (Number(post.poll.closesAt) || 0) - (Number(post.timestamp) || 0), 60 * 1000);
        const closesAt = Date.now() + length;
        mutatePost(post.id, (p) => { if (p.poll) p.poll.closesAt = closesAt; });
        txid = await submitKaPoll({ engine: deps.engine, question: post.text, options: post.poll.options, closesAtMs: closesAt, mentionedPubkeys: await mentionedPubkeysFor(post.text) });
      } else {
        txid = await submitKaPost({ engine: deps.engine, text: post.text, mentionedPubkeys: await mentionedPubkeysFor(post.text) });
      }
      mutatePost(post.id, (p) => { p.remoteId = txid; p.delivery = "sent"; });
    } catch (error) {
      mutatePost(post.id, (p) => { p.delivery = "failed"; p.failureReason = error?.message || String(error); });
      deps.appendEngineLog?.(`KaPost retry failed: ${userFacingError(error)}`);
    }
    renderAll();
  })();
}

// ---------------------------------------------------------------------------
// Composer + meter
// ---------------------------------------------------------------------------

// iOS KaPostCharacterMeter: a ring filling toward the 25,000-character limit, visible from the
// first character, orange with a live remaining count in the final 10%, red at the wall.
function updateMeter(input, meter, submit = null) {
  const limit = KAPOSTS_POST_CHARACTER_LIMIT;
  // Counted in characters as the reader sees them (code points, so an emoji is one), as iOS
  // counts `text.count` - not UTF-16 units, which charged an emoji twice.
  if (input.value.length > limit && kapostsCharCount(input.value) > limit) input.value = kapostsClampChars(input.value, limit);
  const count = kapostsCharCount(input.value);
  const remaining = limit - count;
  const progress = Math.min(1, count / limit);
  const nearLimit = progress >= 0.9;
  meter.hidden = count === 0;
  meter.classList.toggle("near", nearLimit && remaining > 0);
  meter.classList.toggle("over", remaining <= 0);
  const circumference = 2 * Math.PI * 8;
  meter.innerHTML = `
    ${nearLimit ? `<span class="kaposts-meter-count">${remaining}</span>` : ""}
    <svg class="kaposts-meter-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="8" class="track"/>
      <circle cx="10" cy="10" r="8" class="fill" stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${(circumference * (1 - progress)).toFixed(2)}"/>
    </svg>`;
  if (submit) submit.disabled = input.value.trim().length === 0;
  if (input === composerInput) scheduleComposerFeeEstimate();
  // The pinned reply box's arrow is grey and inert while there is nothing to send (iOS).
  if (input === replyInput && replySend) replySend.disabled = input.value.trim().length === 0;
}

// Live network-fee estimate while typing (Settings > Show Fee Estimate), matching the chat
// composer's behaviour. Debounced: the estimate asks the node, and typing is faster than that.
let composerFeeTimer = null;
let composerFeeToken = 0;
function scheduleComposerFeeEstimate() {
  const row = composerEl?.querySelector("[data-kaposts-composer-fee]");
  if (!row) return;
  const text = String(composerInput?.value || "").trim();
  if (!text || !deps.showFeeEstimate?.() || !deps.estimatePostFeeKas) { row.hidden = true; return; }
  if (composerFeeTimer) clearTimeout(composerFeeTimer);
  const token = ++composerFeeToken;
  composerFeeTimer = setTimeout(async () => {
    try {
      const feeKas = await deps.estimatePostFeeKas(text);
      if (token !== composerFeeToken) return;
      if (feeKas == null) { row.hidden = true; return; }
      row.textContent = `Est. fee: ${Number(feeKas).toFixed(8)} ${KAS_UNIT}`;
      row.hidden = false;
    } catch {
      if (token === composerFeeToken) row.hidden = true;
    }
  }, 450);
}

// Thread segments stacked in the composer (X-style "+"), oldest first.
let composerThreadSegments = [];

function composerSegmentsEl() { return document.querySelector("[data-kaposts-thread-segments]"); }
function composerThreadAddEl() { return document.querySelector("[data-kaposts-thread-add]"); }

// Applies a toolbar button to whatever is selected in the composer, then restores focus and puts
// the selection where the edit says it belongs (inside fresh markers, or over the link target).
function applyComposerFormatting(action) {
  if (!composerInput) return;
  const edit = applyKaPostsMarkdownAction(action, composerInput.value, composerInput.selectionStart, composerInput.selectionEnd);
  composerInput.value = edit.text;
  composerInput.focus();
  composerInput.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  composerInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderComposerThreadUi() {
  const listEl = composerSegmentsEl();
  const addBtn = composerThreadAddEl();
  const trimmed = composerInput ? composerInput.value.trim() : "";
  const total = composerThreadSegments.length + (trimmed ? 1 : 0);
  if (listEl) {
    listEl.hidden = composerThreadSegments.length === 0;
    listEl.innerHTML = composerThreadSegments.map((segment, index) => `
      <div class="kaposts-thread-segment">
        <span class="kaposts-thread-segment-num">${index + 1}</span>
        <span class="kaposts-thread-segment-text">${deps.escapeHtml(segment)}</span>
        <button type="button" class="kaposts-thread-segment-remove" data-kaposts-thread-remove="${index}" aria-label="Remove segment">×</button>
      </div>`).join("");
  }
  // The + appears once you type, and never while quoting or replying - both are one post about
  // one other post, so neither stacks into a thread.
  if (addBtn) addBtn.hidden = Boolean(composerQuoteTarget) || Boolean(composerReplyTarget) || Boolean(composerEditTarget) || !trimmed || Boolean(composerPoll) || composerScheduleAt != null;
  // iOS KaPostComposerView's header: an edit is "Edit Post" / "Save" whatever it edits, a reply
  // "Reply to Post" / "Reply", a quote "Quote Post"; this runs on every keystroke, so each mode
  // has to win here or the next render resets it.
  if (composerTitle) {
    composerTitle.textContent = composerEditTarget ? "Edit Post"
      : composerReplyTarget ? "Reply to Post"
        : composerQuoteTarget ? "Quote Post"
          : (composerThreadSegments.length ? "New Thread" : "New Post");
  }
  if (composerSubmit) {
    composerSubmit.textContent = composerEditTarget ? "Save"
      : composerReplyTarget ? "Reply"
        : composerPoll ? "Post Poll"
          : composerScheduleAt != null ? "Schedule"
            : (total > 1 ? `Post All (${total})` : "Post");
    // A poll posts only with its question and two to four valid options (iOS canPost).
    composerSubmit.disabled = composerPoll ? !(trimmed && pollEditorValid()) : total === 0;
  }
  if (composerInput) {
    composerInput.placeholder = composerReplyTarget
      ? "Post your reply"
      : composerQuoteTarget
        ? "Add a comment"
        : (composerThreadSegments.length ? "Add another post" : "What's happening on Kaspa?");
  }
}

/// Puts an undone draft back where it was written, so the five seconds are a chance to fix
/// something rather than a chance to lose it (iOS restoreDraft).
function restoreComposerDraft(text, { quoted = null, segments = [], pollOptions = null } = {}) {
  const value = String(text || "");
  if (!value.trim()) return;
  // Straight back into the composer, as iOS restoreDraft does: the zero-balance gate guards the
  // create-post button, not the way back to writing already done.
  openComposer(quoted);
  composerThreadSegments = [...segments];
  // An undone poll comes back as a poll, its options filled in (iOS 2c9e1ec); the length is not
  // carried and starts again at the default 24 hours, as on iOS.
  if (Array.isArray(pollOptions) && pollOptions.length) {
    composerPoll = { options: [...pollOptions], lengthMs: 86400000 };
    composerScheduleAt = null;
    renderComposerExtras();
  }
  composerInput.value = value;
  composerInput.dispatchEvent(new Event("input", { bubbles: true }));
  renderComposerThreadUi();
  composerInput.focus();
}

/// The reply bar grows with what is being typed instead of staying one line tall and scrolling
/// its own middle out of view - the same rule the chat and group composers already follow. Capped
/// at the field's CSS max-height so the two cannot disagree; past that it scrolls, because a reply
/// box that keeps growing pushes the post being replied to off the screen (iOS caps it at 92pt for
/// exactly that reason).
/// The inline reply box grows with what is typed, then scrolls - a box that keeps growing pushes
/// the post being answered off the screen.
const REPLY_MAX_HEIGHT_PX = 140;
function autoGrowReply() {
  if (!replyInput) return;
  replyInput.style.height = "auto";
  replyInput.style.height = `${Math.min(replyInput.scrollHeight, REPLY_MAX_HEIGHT_PX)}px`;
}

// The zero-balance gate lives on the create-post button (iOS createPostButton) and on the
// thread's pinned reply box - not here: a reply or quote composer, an edit, a reopened draft and
// an undone post all open as they are.
function openComposer(quoteTarget = null, { replyTarget = null, editTarget = null } = {}) {
  editingDraftId = null;
  composerEditTarget = editTarget;
  // Replying is a composer now, not a bar under the thread: the whole screen to write in, with
  // the post being answered rendered below - the same card a quote shows.
  composerReplyTarget = replyTarget;
  quoteTarget = replyTarget || quoteTarget;
  composerQuoteTarget = replyTarget ? null : quoteTarget;
  if (composerInput) composerInput.placeholder = replyTarget ? "Post your reply" : quoteTarget ? "Add a comment" : "What's happening on Kaspa?";
  // Edit mode opens on the post's current text (no threading, no draft prompt on close).
  composerInput.value = editTarget ? editTarget.text : "";
  composerSubmit.disabled = !editTarget;
  composerMeter.hidden = true;
  composerThreadSegments = [];
  if (quoteTarget) {
    composerQuote.hidden = false;
    // The post this composer is about, five lines of it, with who wrote it and when (iOS
    // quotedPostCard).
    composerQuote.innerHTML = `
      ${quoteCardHeadHtml(quoteTarget, { withTime: true })}
      <span>${markdownPreviewHtml(quoteTarget.text)}</span>`;
  } else {
    composerQuote.hidden = true;
    composerQuote.innerHTML = "";
  }
  composerPoll = null;
  composerScheduleAt = null;
  renderComposerExtras();
  renderComposerThreadUi();
  composerEl.hidden = false;
  composerInput.focus();
}

// Poll and Schedule (iOS 3b1aecf extrasAvailable) belong to a plain new post: never to a reply, a
// quote, an edit, a thread - or a reopened draft, whose composer iOS opens without them.
function composerExtrasAllowed() {
  return !composerQuoteTarget && !composerReplyTarget && !composerEditTarget && !editingDraftId
    && composerThreadSegments.length === 0;
}

/// "Sep 24, 2026 at 9:27 AM" style, as iOS DateFormatter.localizedString(.medium, .short).
function scheduleWhenText(ms) {
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function renderComposerExtras() {
  const pollEditor = document.querySelector("[data-kaposts-poll-editor]");
  const scheduleRow = document.querySelector("[data-kaposts-schedule-editor]");
  const pollToggle = document.querySelector("[data-kaposts-poll-toggle]");
  const scheduleToggle = document.querySelector("[data-kaposts-schedule-toggle]");
  const allowed = composerExtrasAllowed();
  // iOS extrasRow: both chips stay while extras are allowed. Poll toggles to a filled "Remove
  // poll"; Schedule reads "Reschedule" (filled) once a time is set, and is dimmed and disabled
  // while a poll is on.
  if (pollToggle) {
    pollToggle.hidden = !allowed;
    pollToggle.classList.toggle("filled", Boolean(composerPoll));
    const label = pollToggle.querySelector("span");
    if (label) label.textContent = composerPoll ? "Remove poll" : "Poll";
  }
  if (scheduleToggle) {
    scheduleToggle.hidden = !allowed;
    scheduleToggle.disabled = Boolean(composerPoll);
    scheduleToggle.classList.toggle("filled", composerScheduleAt != null);
    const label = scheduleToggle.querySelector("span");
    if (label) label.textContent = composerScheduleAt != null ? "Reschedule" : "Schedule";
  }
  if (pollEditor) {
    pollEditor.hidden = !(allowed && composerPoll);
    if (composerPoll) {
      const list = pollEditor.querySelector("[data-kaposts-poll-options]");
      if (list) {
        list.innerHTML = composerPoll.options.map((option, index) => `
          <div class="kaposts-poll-option-row">
            <input class="kaposts-reply-input" type="text" placeholder="Option ${index + 1}" value="${deps.escapeHtml(option)}" data-kaposts-poll-option="${index}" />
            ${composerPoll.options.length > KAPOSTS_POLL_MIN_OPTIONS ? `<button type="button" class="kaposts-thread-segment-remove" data-kaposts-poll-option-remove="${index}" aria-label="Remove option">×</button>` : ""}
          </div>`).join("");
      }
      const add = pollEditor.querySelector("[data-kaposts-poll-add]");
      if (add) add.hidden = composerPoll.options.length >= KAPOSTS_POLL_MAX_OPTIONS;
      const length = pollEditor.querySelector("[data-kaposts-poll-length]");
      if (length) length.value = String(composerPoll.lengthMs);
    }
  }
  if (scheduleRow) {
    scheduleRow.hidden = !(allowed && composerScheduleAt != null);
    const label = scheduleRow.querySelector("[data-kaposts-schedule-label]");
    if (label) label.textContent = composerScheduleAt != null ? `Scheduled for ${scheduleWhenText(composerScheduleAt)}` : "";
  }
  renderComposerThreadUi();
}

/// The options a poll would post: trimmed, the empty ones left out (iOS validPollOptions).
function validPollOptions() {
  return (composerPoll?.options || []).map((o) => String(o || "").trim()).filter(Boolean);
}
function pollEditorValid() {
  if (!composerPoll) return true;
  const options = validPollOptions();
  if (options.length < KAPOSTS_POLL_MIN_OPTIONS || options.length > KAPOSTS_POLL_MAX_OPTIONS) return false;
  // XP-007: counted in Unicode scalars, as the indexer counts them (not UTF-16 `length`).
  if (options.some((o) => pollOptionLength(o) > KAPOSTS_POLL_OPTION_MAX_LENGTH)) return false;
  return new Set(options).size === options.length;
}

// --- Schedule picker (iOS extrasRow's sheet): a time 5 minutes to 30 days out ---------------
function scheduleSheetEl() { return document.querySelector("[data-kaposts-schedule-sheet]"); }
function localInputValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function scheduleSheetPick() {
  const input = scheduleSheetEl()?.querySelector("[data-kaposts-schedule-input]");
  const when = input ? new Date(input.value).getTime() : NaN;
  if (!Number.isFinite(when)) return null;
  // Clamped into the picker's range, as the iOS DatePicker's `in:` range clamps.
  const now = Date.now();
  return Math.min(now + KAPOSTS_SCHEDULE_MAX_MS, Math.max(now + KAPOSTS_SCHEDULE_MIN_MS, when));
}
function syncScheduleSheetButton() {
  const sheet = scheduleSheetEl();
  const confirm = sheet?.querySelector("[data-kaposts-schedule-confirm]");
  if (!confirm) return;
  const pick = scheduleSheetPick();
  confirm.textContent = pick != null ? `Schedule for ${scheduleWhenText(pick)}` : "Schedule";
  confirm.disabled = pick == null;
}
function openScheduleSheet() {
  const sheet = scheduleSheetEl();
  const input = sheet?.querySelector("[data-kaposts-schedule-input]");
  if (!sheet || !input) return;
  const now = Date.now();
  input.min = localInputValue(now + KAPOSTS_SCHEDULE_MIN_MS);
  input.max = localInputValue(now + KAPOSTS_SCHEDULE_MAX_MS);
  input.value = localInputValue(composerScheduleAt ?? now + 60 * 60 * 1000);
  syncScheduleSheetButton();
  sheet.hidden = false;
  input.focus();
}
function closeScheduleSheet() {
  const sheet = scheduleSheetEl();
  if (sheet) sheet.hidden = true;
}

async function closeComposer({ keepDraft = null } = {}) {
  // Closing with unfinished writing in the box is the moment a draft is worth anything. Asked
  // rather than assumed in both directions: saving silently fills the list with abandoned
  // half-sentences, and discarding silently is how people lose what they were writing.
  const hasContent = [String(composerInput?.value || ""), ...composerThreadSegments].some((s) => s.trim());
  let save = keepDraft;
  if (composerEditTarget) save = false; // an edit is not a draft
  if (save === null && hasContent) {
    // iOS ComposerCloseOptionsSheet: each choice says what happens to the post. Closing the
    // chooser itself (Escape, backdrop) keeps you in the composer with nothing lost.
    const choice = await deps.chooseDialog?.({
      title: "Save this post?",
      options: [
        { id: "save", title: "Save Draft", subtitle: "Keep it in Drafts to finish later." },
        { id: "discard", title: "Discard", subtitle: "Throw this away.", destructive: true },
      ],
    });
    if (choice == null) return;
    save = choice === "save";
  }
  if (save) saveDraftFromComposer();

  closeScheduleSheet();
  composerEl.hidden = true;
  composerPoll = null;
  composerScheduleAt = null;
  composerQuoteTarget = null;
  // Cleared with the rest: a reply composer closed and reopened as a new post would otherwise
  // still submit as a reply to whatever it was last pointed at.
  composerReplyTarget = null;
  composerEditTarget = null;
  composerThreadSegments = [];
  editingDraftId = null;
  renderComposerThreadUi();
  if (save) renderAll();
}

// Saving an edit (iOS 2d483a7, 90331bc): the new text shows at once, the usual 5s undo puts
// the previous text back exactly, then the edit goes on chain; a failed transaction restores
// the old text. The green check counts from the edit landing.
function scheduleEdit(post, text) {
  const previous = post.text;
  const previousEditedAt = post.editedAt ?? null;
  const next = String(text || "").trim();
  if (!post.remoteId || !next || next === previous) return;
  // Shown at once as an edit in flight (iOS editPost): the new text, "· edited" and the spinner.
  // Undo, or a failed transaction, puts the text and its edited state back exactly.
  const restore = (p) => { p.text = previous; p.editedAt = previousEditedAt; p.delivery = "sent"; };
  mutatePost(post.id, (p) => { p.text = next; p.editedAt = Date.now(); p.delivery = "pending"; });
  renderAll();
  scheduleUndoable(`edit:${post.id}`, async () => {
    try {
      await submitKaPostEdit({ engine: deps.engine, postId: post.remoteId, text: next, mentionedPubkeys: await mentionedPubkeysFor(next) });
      mutatePost(post.id, (p) => { p.sentAt = Date.now(); p.delivery = "sent"; });
    } catch (error) {
      mutatePost(post.id, restore);
      deps.appendEngineLog?.(`KaPost edit failed: ${error.message}`);
      // iOS fae6686: a failed edit says so in an alert (it used to be logged and nothing more).
      deps.alertDialog?.({ title: "KaPosts", message: `Couldn't save the edit: ${actionErrorText(error)}`, confirmLabel: "OK" });
    }
    renderAll();
  }, () => {
    mutatePost(post.id, restore);
    renderAll();
  }, "Saving edit");
}

// Deleting one of our own posts (iOS 5a55f62): the card dims behind the 5s undo countdown -
// Undo just lifts it - then the delete goes on chain and the post leaves every list and
// comment tree; deleting the post an open thread is about closes the thread.
function scheduleDelete(post) {
  if (!post.remoteId || post.delivery !== "sent" || post.pendingDeletion) return;
  // The card stays dimmed until the delete is on chain (iOS pendingDeletion); the post leaving
  // every list is the whole confirmation, and a failed delete just lifts the dim.
  mutatePost(post.id, (p) => { p.pendingDeletion = true; });
  scheduleUndoable(`delete:${post.id}`, async () => {
    try {
      await submitKaPostDelete({ engine: deps.engine, postId: post.remoteId });
      removePostEverywhere(post);
    } catch (error) {
      mutatePost(post.id, (p) => { p.pendingDeletion = false; });
      deps.appendEngineLog?.(`KaPost delete failed: ${error.message}`);
      deps.alertDialog?.({ title: "KaPosts", message: `Couldn't delete the post: ${actionErrorText(error)}`, confirmLabel: "OK" });
    }
    renderAll();
  }, () => {
    mutatePost(post.id, (p) => { p.pendingDeletion = false; });
  }, "Deleting post");
}

/// The reason a KaPosts action failed, in the words the app uses elsewhere (iOS UserFacingError).
function actionErrorText(error) {
  return userFacingError(error) || String(error?.message || error || "Something went wrong.");
}

function removePostEverywhere(post) {
  const id = post.id;
  const remoteId = post.remoteId || null;
  const gone = (p) => p && (p.id === id || (remoteId && p.remoteId === remoteId));
  const prune = (list) => {
    if (!Array.isArray(list)) return list;
    const kept = list.filter((p) => !gone(p));
    for (const p of kept) if (Array.isArray(p.comments)) p.comments = prune(p.comments);
    return kept;
  };
  localPosts = prune(localPosts);
  remotePosts = prune(remotePosts);
  pendingNewPosts = prune(pendingNewPosts);
  myContentPosts = prune(myContentPosts);
  if (activePanel?.posts) activePanel.posts = prune(activePanel.posts);
  if (activePanel?.replies) activePanel.replies = prune(activePanel.replies);
  for (const [key, chain] of threadChains.entries()) threadChains.set(key, prune(chain));
  if (threadStack.includes(id)) {
    threadStack = threadStack.filter((entry) => entry !== id);
    pendingThreadScrollRemoteId = null;
    threadHighlightRemoteId = null;
  }
}

// ---------------------------------------------------------------------------
// Panels (profile / notifications / engagement / bookmarks / muted / blocked / menu)
// ---------------------------------------------------------------------------

function syncRailActive() {
  syncRailBadge();
  const current = !activePanel
    ? "feed"
    : activePanel.type === "list"
      ? activePanel.kind
      : activePanel.type === "profile" && activePanel.address === deps.engine.address
        ? "profile"
        : activePanel.type === "notifications"
          ? "notifications"
          : null;
  document.querySelectorAll("[data-kaposts-rail]").forEach((button) => {
    button.classList.toggle("active", button.dataset.kapostsRail === current);
  });
}

/**
 * Prepares a panel for display, deciding whether it takes the viewport or is presented OVER an
 * open thread. Opened from inside a thread it is an over-thread panel, and whatever panel the
 * thread itself was opened from is parked in `beneath` so closing this one restores the thread
 * and a later thread-back still lands on that original panel.
 */
function beginPanel(next) {
  if (threadStack.length > 0) {
    next.beneath = panelOverThread ? (activePanel?.beneath || null) : (activePanel || null);
    panelOverThread = true;
  } else {
    panelOverThread = false;
  }
  return next;
}

function closePanel() {
  // An over-thread panel closes back to the thread, handing the viewport to whatever panel
  // the thread was opened from (usually none).
  activePanel = panelOverThread ? (activePanel?.beneath || null) : null;
  panelOverThread = false;
  panelGeneration += 1; // any page still in flight for the panel we just left is now stale
  clearPanelPagerSentinels();
  renderPanel();
  if (threadStack.length > 0) renderThread();
  syncRailActive();
  restoreFeedScroll();
}

// Outline paths for the side-menu panels' empty states and row marks, standing in for the SF
// Symbols iOS uses there (KaPostsView.swift profileFeedPage / KaPostsFollowListView /
// KaPostsNotificationsView / moderationSheet / scheduledSheet / bookmarksSheet).
const PANEL_ICONS = {
  compose: "m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10", // square.and.pencil
  bubble: "M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z", // bubble.left
  idCard: "M15 9h3.75M15 12h3.75M15 15h3.75M4.5 19.5h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Zm6-10.125a1.875 1.875 0 1 1-3.75 0 1.875 1.875 0 0 1 3.75 0Zm1.294 6.336a6.721 6.721 0 0 1-3.17.789 6.721 6.721 0 0 1-3.168-.789 3.376 3.376 0 0 1 6.338 0Z", // person.text.rectangle
  personPlus: "M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM4 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 10.374 21c-2.331 0-4.512-.645-6.374-1.766Z", // person.badge.plus
  people: "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z", // person.2
  bell: "M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0", // bell
  bookmark: "M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z", // bookmark
  speakerSlash: "M17.25 9.75 19.5 12m0 0 2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6 4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z", // speaker.slash
  handRaised: "M10.05 4.575a1.575 1.575 0 1 0-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 0 1 3.15 0v1.5m-3.15 0 .075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 0 1 3.15 0V15M6.9 7.575a1.575 1.575 0 1 0-3.15 0v8.175a6.75 6.75 0 0 0 6.75 6.75h2.018a5.25 5.25 0 0 0 3.712-1.538l1.732-1.732a5.25 5.25 0 0 0 1.538-3.712l.003-2.024a.668.668 0 0 1 .198-.471 1.575 1.575 0 1 0-2.228-2.228 3.818 3.818 0 0 0-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0 1 16.35 15m.002 0h-.002", // hand.raised
  clock: "M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", // clock
  computer: "M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25", // iphone: "held on this device"
  checkCircle: "M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", // checkmark.circle.fill
  alertCircle: "M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z", // exclamationmark.circle.fill
  xCircle: "m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", // xmark.circle
  chevron: "m8.25 4.5 7.5 7.5-7.5 7.5", // chevron.right
};

/** iOS's empty-state stack: a large secondary icon, a headline, then the optional body line. */
function panelEmptyHtml(icon, title, body = null) {
  return `<div class="no-results-card kaposts-empty">`
    + (PANEL_ICONS[icon] ? `<svg class="kaposts-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${PANEL_ICONS[icon]}"/></svg>` : "")
    + `<strong>${deps.escapeHtml(title)}</strong>`
    + (body ? `<span>${deps.escapeHtml(body)}</span>` : "")
    + `</div>`;
}

// The panels iOS gives a pull-to-refresh: a profile, Followers / Following, Notifications and
// Scheduled. A mouse has no pull gesture, so the header's refresh button stands in for it.
function panelHasRefresh(panel) {
  return panel?.type === "profile" || panel?.type === "followList" || panel?.type === "notifications"
    || (panel?.type === "list" && panel.kind === "scheduled");
}

function ensurePanelRefreshButton() {
  if (panelRefreshEl || !panelEl) return panelRefreshEl;
  const header = panelEl.querySelector(".kaposts-thread-header");
  if (!header) return null;
  panelRefreshEl = document.createElement("button");
  panelRefreshEl.type = "button";
  panelRefreshEl.className = "kaposts-feed-refresh kaposts-panel-refresh";
  panelRefreshEl.setAttribute("aria-label", "Refresh");
  panelRefreshEl.title = "Refresh";
  panelRefreshEl.hidden = true;
  panelRefreshEl.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>`;
  panelRefreshEl.addEventListener("click", () => refreshActivePanel());
  header.appendChild(panelRefreshEl);
  return panelRefreshEl;
}

function refreshActivePanel() {
  const panel = activePanel;
  if (!panelHasRefresh(panel)) return;
  if (panel.type === "profile") refreshProfilePanel(panel);
  else if (panel.type === "followList") refreshFollowList(panel);
  else if (panel.type === "notifications") loadNotificationsFirstPage(panel);
  else if (panel.type === "list" && panel.kind === "scheduled") refreshScheduledPanel(panel);
}

function renderPanel() {
  const show = Boolean(activePanel);
  syncSurfaces(currentThreadPost());
  if (!show) clearPanelPagerSentinels();
  const refreshButton = ensurePanelRefreshButton();
  if (refreshButton) refreshButton.hidden = !show || !panelHasRefresh(activePanel);
  if (!show || !panelBodyEl) return;
  const panel = activePanel;
  // A Post Activity kind's list is a screen pushed inside the sheet: at phone width its header
  // carries a back arrow, not the sheet's Done (iOS NavigationLink).
  panelEl?.toggleAttribute("data-kaposts-panel-pushed", panel.type === "engagement" && Boolean(panel.tab));
  // Panels rebuild their body wholesale (hero, tab bar and rows share one template), so the
  // scroll position has to be carried over by hand when a page of rows lands.
  const previousTop = panelBodyEl.scrollTop || 0;
  const restorePanelScroll = () => { panelBodyEl.scrollTop = previousTop; };
  const titles = {
    profile: "Profile", notifications: "Notifications", engagement: "Post Activity", tippers: "Tips", search: "Search",
    bookmarks: "Bookmarks", drafts: "Drafts", scheduled: "Scheduled", muted: "Muted", blocked: "Blocked", menu: "KaPosts",
  };
  panelTitleEl.textContent = titles[panel.type === "list" ? panel.kind : panel.type] || "Panel";

  if (panel.type === "search") {
    renderSearchPanel(panel);
    return;
  }

  if (panel.type === "profile") {
    const address = panel.address;
    // Both profile pages - yours and a tapped poster's - show the .kachat banner and bio (iOS 3d6fb7c).
    const profile = posterProfilePieces(address);
    // A .kachat banner is an <img> (no referrer, one relay retry); a KNS one stays a background.
    const kachatBanner = profile.kachat && profile.bannerUrl
      ? `<img class="kaposts-profile-banner-img" alt="" decoding="async" referrerpolicy="no-referrer" data-banner-fit data-kaposts-kachat-img="banner" src="${deps.escapeHtml(profile.bannerUrl)}" />`
      : "";
    const knsBanner = profile.kachat ? "" : safeCssUrl(profile.bannerUrl);
    const isMine = address === deps.engine.address;
    const isFollowing = prefs.following.includes(address);
    // Your own profile merges session posts the indexer has not stamped yet (still pending, or
    // too fresh), newest first - a post you just made belongs on your own Posts tab.
    const remoteItems = panel.tab === "replies" ? (panel.replies || []) : (panel.posts || []);
    const feedItems = isMine && panel.tab !== "replies"
      ? [...remoteItems, ...localPosts.filter((post) => post.posterAddress === address
          && !remoteItems.some((row) => row.remoteId && row.remoteId === post.remoteId))]
          .sort((a, b) => b.timestamp - a.timestamp)
      : remoteItems;
    panelBodyEl.innerHTML = `
      <div class="kaposts-profile-hero">
        <div class="kaposts-profile-banner${kachatBanner ? " has-img" : ""}"${knsBanner ? ` style="background-image:url('${deps.escapeHtml(knsBanner)}')"` : ""}>${kachatBanner}</div>
        <div class="kaposts-profile-row">
          ${posterAvatarHtml(address)}
          <div class="kaposts-profile-meta">
            ${/* iOS myProfileSheet / posterProfileSheet order: name, counts, bio, then (own
                 profile only) the Edit KaChat Profile capsule. Counts read 0 until they load. */ ""}
            <strong>${deps.escapeHtml(posterName(address))}</strong>
            <span class="kaposts-profile-counts">
              <button type="button" class="kaposts-count-link" data-kaposts-follow-list="following"${panel.pubkey ? "" : " disabled"}><b>${isMine ? prefs.following.filter((a) => a !== address).length : (panel.details?.followingCount ?? 0)}</b> Following</button>&nbsp;&nbsp;
              <button type="button" class="kaposts-count-link" data-kaposts-follow-list="followers"${panel.pubkey ? "" : " disabled"}><b>${panel.details?.followersCount ?? 0}</b> Followers</button>
            </span>
            ${profile.bio ? `<span class="kaposts-profile-bio" data-kaposts-profile-bio>${deps.escapeHtml(profile.bio)}</span><button type="button" class="kaposts-bio-more" data-kaposts-bio-more hidden>More</button>` : ""}
            ${isMine ? `<button class="kaposts-edit-kns" type="button" data-kaposts-edit-kns><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PANEL_ICONS.idCard}"/></svg>Edit KaChat Profile</button>` : ""}
          </div>
          ${!isMine ? `<span class="kaposts-profile-actions">
            <button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-profile-follow>${isFollowing ? "Following" : "Follow"}</button>
            <button class="kaposts-profile-chat" type="button" data-kaposts-profile-chat title="Open a chat with ${deps.escapeHtml(posterName(address))}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg>
              Chat
            </button>
          </span>` : ""}
        </div>
      </div>
      <div class="kaposts-feed-tabs kaposts-profile-tabs">
        <button class="kaposts-feed-tab${panel.tab !== "replies" ? " active" : ""}" type="button" data-kaposts-profile-tab="posts">Posts</button>
        <button class="kaposts-feed-tab${panel.tab === "replies" ? " active" : ""}" type="button" data-kaposts-profile-tab="replies">Replies</button>
      </div>
      <div class="kaposts-panel-list" data-kaposts-panel-list>
        ${panel.loading && feedItems.length === 0
          ? `<div class="kaposts-feed-status">Loading…</div>`
          : feedItems.length === 0
            ? panelEmptyHtml(
                panel.tab === "replies" ? "bubble" : "compose",
                panel.tab === "replies" ? "No replies yet" : "No posts yet",
                isMine ? (panel.tab === "replies" ? "Replies you post will show up here." : "Your posts will show up here.") : null,
              )
            : feedItems.map((post) => postCellHtml(post, { inThread: true, openByRemote: true })).join("")}
      </div>`;
    // The whole banner at the full width, at its own proportions (iOS c66bfc7).
    // A .kachat <img> banner sizes its box itself when it loads (banner-fit.js data-banner-fit).
    fitBackgroundBanner(panelBodyEl.querySelector(".kaposts-profile-banner"), knsBanner || "");
    // More appears only when the three-line clamp actually hid something.
    const bioEl = panelBodyEl.querySelector("[data-kaposts-profile-bio]");
    const bioMore = panelBodyEl.querySelector("[data-kaposts-bio-more]");
    if (bioEl && bioMore) bioMore.hidden = !(bioEl.scrollHeight > bioEl.clientHeight + 1);
    const profileTab = panel.tab === "replies" ? "replies" : "posts";
    mountPagerSentinel(
      `profile-${profileTab}`,
      panelBodyEl.querySelector("[data-kaposts-panel-list]"),
      panel.loading ? null : panel.pagers?.[profileTab], // the first page owns the Loading… state
      () => loadMoreProfile(profileTab),
    );
    clearPagerSentinel(profileTab === "posts" ? "profile-replies" : "profile-posts");
    restorePanelScroll();
    return;
  }

  if (panel.type === "notifications") {
    const items = panel.items || [];
    panelBodyEl.innerHTML = `<div class="kaposts-panel-list" data-kaposts-panel-list>${
      panel.loading && items.length === 0
      ? `<div class="kaposts-feed-status">Loading…</div>`
      : items.length === 0
        ? panelEmptyHtml("bell", "Nothing yet", "When someone likes, replies to or shares your posts, it shows up here.")
        : items.map((item) => `
            <div class="kaposts-notification-row openable" data-kaposts-notification="${deps.escapeHtml(item.id)}">
              <span class="kaposts-notification-avatar">
                ${posterAvatarHtml(item.actorAddress)}
                <span class="kaposts-notification-kind kind-${item.kind}">${item.kind === "tip" ? `<img src="${kaspaLogoUrl}" alt="" aria-hidden="true" />` : (NOTIFICATION_KIND_ICONS[item.kind] || NOTIFICATION_KIND_ICONS.other)}</span>
              </span>
              <div class="kaposts-notification-main">
                <span><strong>${deps.escapeHtml(posterName(item.actorAddress))}</strong> ${deps.escapeHtml(item.action)}</span>
                ${item.snippet ? `<span class="kaposts-notification-snippet">${deps.escapeHtml(item.snippet)}</span>` : ""}
                <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(item.timestamp))}</span>
              </div>
              <svg class="kaposts-search-chevron kaposts-notification-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="${PANEL_ICONS.chevron}"/></svg>
            </div>`).join("")
    }</div>`;
    mountPagerSentinel(
      "notifications",
      panelBodyEl.querySelector("[data-kaposts-panel-list]"),
      panel.loading ? null : panel.pager,
      loadMoreNotifications,
    );
    restorePanelScroll();
    return;
  }

  if (panel.type === "engagement") {
    const lists = panel.lists || { likes: [], dislikes: [], reposts: [], quotes: [] };
    // No kind picked: one square card per kind with its count (iOS 8ffa130). A card opens
    // that kind's list in the same panel, titled with the kind's name; Back returns here.
    if (!panel.tab) {
      clearPagerSentinel("engagement");
      clearPagerSentinel("engagement-tips");
      const activityPost = findPost(panel.postId);
      panelBodyEl.innerHTML = `
        <div class="kaposts-activity-grid">
          ${ENGAGEMENT_KINDS.map((kind) => `
            <button type="button" class="hub-tile kaposts-activity-tile" data-kaposts-engagement-tab="${kind.key}">
              <span class="kaposts-activity-icon kind-${kind.key}">${engagementKindIconHtml(kind.key)}</span>
              <span class="kaposts-activity-count">${deps.escapeHtml(engagementCountText(panel, lists, activityPost, kind.key))}</span>
              <span class="kaposts-activity-name">${kind.label}</span>
            </button>`).join("")}
        </div>
        ${panel.postTxId ? `<a class="kaposts-view-link kaposts-post-tx-link kaposts-activity-tx-link" href="${deps.escapeHtml(deps.explorerTxUrl(panel.postTxId))}" target="_blank" rel="noopener">View Post Transaction in Explorer</a>` : ""}`;
      restorePanelScroll();
      return;
    }
    const tab = panel.tab;
    panelTitleEl.textContent = ENGAGEMENT_KINDS.find((kind) => kind.key === tab)?.label || "Post Activity";
    const rows = lists[tab] || [];
    // Tips (iOS 8015069): who tipped, how much and when, from get-post-tippers on its own cursor.
    const listHtml = tab === "tips"
      ? tipperRowsHtml(panel, { showError: false })
      : panel.loading
        ? `<div class="kaposts-feed-status">Loading…</div>`
        : rows.length === 0
          ? `<div class="no-results-card"><strong>Nothing here yet</strong><span>When someone engages with this post, they'll show up here.</span></div>`
          : rows.map((entry) => `
                <div class="kaposts-notification-row">
                  ${posterAvatarHtml(entry.actorAddress)}
                  <div class="kaposts-notification-main">
                    <span><strong>${deps.escapeHtml(posterName(entry.actorAddress))}</strong></span>
                    <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(entry.timestamp))}</span>
                  </div>
                  <a class="kaposts-view-link" href="${deps.escapeHtml(deps.explorerTxUrl(entry.actionTxId))}" target="_blank" rel="noopener">View</a>
                </div>`).join("");
    panelBodyEl.innerHTML = `
      <div class="kaposts-panel-list" data-kaposts-panel-list>
        ${listHtml}
      </div>`;
    const listEl = panelBodyEl.querySelector("[data-kaposts-panel-list]");
    if (tab === "tips") {
      clearPagerSentinel("engagement");
      mountPagerSentinel("engagement-tips", listEl, panel.tipsLoaded ? panel.tipsPager : null, loadMoreTips);
    } else {
      clearPagerSentinel("engagement-tips");
      mountPagerSentinel("engagement", listEl, panel.loading ? null : panel.pager, loadMoreEngagement);
    }
    restorePanelScroll();
    return;
  }

  if (panel.type === "tippers") {
    // Who tipped a post (iOS a6bd60a KaPostTippersView): opened from your own post's tip count.
    panelBodyEl.innerHTML = `<div class="kaposts-panel-list" data-kaposts-panel-list>${tipperRowsHtml(panel, { showError: true })}</div>`;
    mountPagerSentinel(
      "tippers",
      panelBodyEl.querySelector("[data-kaposts-panel-list]"),
      panel.tipsLoaded ? panel.tipsPager : null,
      loadMoreTips,
    );
    restorePanelScroll();
    return;
  }

  if (panel.type === "followList") {
    clearPanelPagerSentinels();
    panelTitleEl.textContent = panel.mode === "followers" ? "Followers" : "Following";
    const rows = panel.rows || [];
    panelBodyEl.innerHTML = `<div class="kaposts-panel-list" data-kaposts-panel-list>${
      panel.loading && rows.length === 0
        ? `<div class="kaposts-feed-status">Loading…</div>`
        : rows.length === 0
          ? (panel.mode === "followers"
            ? panelEmptyHtml("people", "No followers yet", "When someone follows you, they'll show up here.")
            : panelEmptyHtml("personPlus", "Not following anyone yet", "Accounts you follow will show up here."))
          : rows.map((row) => {
              const isMe = row.address === deps.engine.address;
              const isFollowing = prefs.following.includes(row.address);
              // Unfollow in the Following list; Follow Back (or Unfollow) in the Followers list.
              // Rows stay in place after a toggle so it's reversible.
              const label = isFollowing ? "Unfollow" : (panel.mode === "followers" ? "Follow Back" : "Follow");
              // The row itself does nothing (iOS entryRow has no tap); only its button acts.
              return `
              <div class="kaposts-notification-row">
                ${posterAvatarHtml(row.address)}
                <div class="kaposts-notification-main">
                  <span><strong>${deps.escapeHtml(posterName(row.address))}</strong></span>
                  ${row.timestamp ? `<span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(row.timestamp))}</span>` : ""}
                </div>
                ${isMe ? "" : `<button class="kaposts-follow${isFollowing ? " following" : ""}" type="button" data-kaposts-follow-list-follow data-address="${deps.escapeHtml(row.address)}" data-pubkey="${deps.escapeHtml(row.pubkey || "")}">${label}</button>`}
              </div>`;
            }).join("")
    }</div>`;
    // Endless scroll on the server list (iOS KaPostsFollowListView: trigger row + load-more footer).
    if (rows.length > 0) {
      mountPagerSentinel("followList", panelBodyEl.querySelector("[data-kaposts-panel-list]"), panel.pager, loadMoreFollowList);
    }
    restorePanelScroll();
    return;
  }

  if (panel.type === "list") {
    // Bookmarks/Muted/Blocked are pure client-side lists (see the note on openBookmarks-style
    // panels below) — nothing to page, so no sentinel may survive here.
    clearPanelPagerSentinels();
    if (panel.kind === "bookmarks") {
      // Bookmarks are a local flag on already-loaded posts — the indexer has no bookmark
      // endpoint and no cursor to follow, so this list grows as the feed pages in rather
      // than paging itself.
      const bookmarks = bookmarkedPostsAndComments();
      panelBodyEl.innerHTML = bookmarks.length === 0
        ? panelEmptyHtml("bookmark", "No bookmarks yet", "Tap the bookmark on any post to save it here.")
        : bookmarks.map((post) => postCellHtml(post, { inThread: true, openByRemote: true })).join("");
      // iOS bookmarksSheet: the card tap stays inert and the name/avatar open nothing
      // (onOpenProfile: {}); the post's own buttons and a quoted post's embed still work.
      panelBodyEl.querySelectorAll(".kaposts-cell").forEach((cell) => {
        cell.classList.remove("openable");
        cell.removeAttribute("data-kaposts-open-remote");
        cell.removeAttribute("data-kaposts-open");
        cell.querySelectorAll("[data-kaposts-profile]").forEach((tap) => {
          tap.removeAttribute("data-kaposts-profile");
          tap.classList.remove("kaposts-avatar-tap");
        });
      });
      restorePanelScroll();
      return;
    }
    if (panel.kind === "drafts") {
      panelBodyEl.innerHTML = draftsPanelHtml();
      restorePanelScroll();
      return;
    }
    if (panel.kind === "scheduled") {
      panelBodyEl.innerHTML = scheduledPanelHtml();
      restorePanelScroll();
      if (!panel.refreshed) { panel.refreshed = true; refreshScheduledPanel(panel); }
      return;
    }
    // Sorted, as iOS moderationSheet lists them (`.sorted()`).
    const addresses = [...(panel.kind === "muted" ? prefs.muted : prefs.blocked)].sort();
    panelBodyEl.innerHTML = addresses.length === 0
      ? panelEmptyHtml(
          panel.kind === "muted" ? "speakerSlash" : "handRaised",
          `No ${panel.kind} accounts`,
          panel.kind === "muted"
            ? "Accounts you mute disappear from your feeds but can still interact with you."
            : "Blocked accounts are removed everywhere and can't interact with you.",
        )
      : addresses.map((address) => `
          <div class="kaposts-notification-row">
            ${posterAvatarHtml(address)}
            <div class="kaposts-notification-main"><span><strong>${deps.escapeHtml(posterName(address))}</strong></span></div>
            <button class="kaposts-view-link" type="button" data-kaposts-unhide="${deps.escapeHtml(address)}" data-kaposts-unhide-kind="${panel.kind}">
              ${panel.kind === "muted" ? "Unmute" : "Unblock"}
            </button>
          </div>`).join("");
    restorePanelScroll();
  }
}

// ---------------------------------------------------------------------------
// Search (iOS KaPostsSearchView)
// ---------------------------------------------------------------------------
//
// CLIENT-SIDE, because the K indexer has no search endpoint - every one of its routes is a feed
// or a lookup by id. So this pages the global feed and filters what comes back, which has one
// honest consequence worth stating in the UI rather than hiding: it searches as far back as it
// has paged, not the whole chain. "Keep looking" / "Search older posts" is how the user asks it
// to go further, and it says how far it has got.
//
// People are derived from the authors of the posts it scans, which is what makes "only people
// who have posted" true by construction: an address is only ever offered because a post of
// theirs was read.

function openSearchPanel() {
  rememberFeedScroll();
  panelGeneration += 1;
  clearPanelPagerSentinels();
  activePanel = beginPanel({
    type: "search", scope: "posts", query: "", scanned: [], loadFailed: false,
    pager: makePager(),
  });
  renderPanel();
  syncRailActive();
  // One page up front so the first search has something to answer with.
  loadMoreSearch();
  panelBodyEl?.querySelector("[data-kaposts-search-input]")?.focus();
}

function loadMoreSearch() {
  const panel = activePanel;
  if (panel?.type !== "search" || !panel.pager) return;
  const generation = panelGeneration;
  panel.pager.error = null;
  panel.pager.stalled = false;
  panel.pager.unproductive = 0;
  panel.loadFailed = false;
  const known = new Set(panel.scanned.map((post) => post.remoteId));
  return runPager(panel.pager, {
    fetchPage: async (before, limit) => {
      // Always the global feed, whichever feed tab is showing (iOS KaPostsSearchView pages
      // fetchGlobalFeed): searching from Following must not search only the people you follow.
      const result = await fetchGlobalFeed({ engine: deps.engine, limit, before });
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter((post) => post && post.remoteId && !known.has(post.remoteId));
      mapped.forEach((post) => known.add(post.remoteId));
      panel.scanned = [...panel.scanned, ...mapped];
      renderSearchResults(panel);
      // Warm the names for whoever just arrived, so People rows are not a wall of addresses.
      resolvePosterIdentities(mapped.map((post) => post.posterAddress), () => {
        if (activePanel === panel) renderSearchResults(panel);
      });
      // Every scanned post counts as progress here - the search's own filter is the query,
      // not the pager's visibility rule.
      return mapped.length;
    },
    isStale: () => generation !== panelGeneration || activePanel !== panel,
    onUpdate: () => {
      if (activePanel === panel) {
        if (panel.pager.error) { panel.loadFailed = true; panel.pager.error = null; }
        renderSearchResults(panel);
      }
    },
  });
}

function searchQuery(panel) {
  return String(panel.query || "").trim().toLowerCase();
}

function matchingSearchPosts(panel) {
  const query = searchQuery(panel);
  if (!query) return [];
  return panel.scanned.filter((post) => {
    if (isHiddenAuthor(post.posterAddress)) return false;
    if (post.text.toLowerCase().includes(query)) return true;
    // A post also matches on WHO wrote it, so searching a name finds their posts without
    // having to switch tabs to find them first.
    return posterName(post.posterAddress).toLowerCase().includes(query);
  });
}

// One row per author, with how many of their scanned posts matched - so the list is ordered
// by who is actually active on this term rather than by whoever posted most recently.
function matchingSearchPeople(panel) {
  const query = searchQuery(panel);
  if (!query) return [];
  const counts = new Map();
  const pubkeys = new Map();
  for (const post of panel.scanned) {
    if (!post.posterAddress || isHiddenAuthor(post.posterAddress)) continue;
    counts.set(post.posterAddress, (counts.get(post.posterAddress) || 0) + 1);
    if (post.posterPubkey && !pubkeys.has(post.posterAddress)) pubkeys.set(post.posterAddress, post.posterPubkey);
  }
  return [...counts.entries()]
    .filter(([address]) => posterName(address).toLowerCase().includes(query) || address.toLowerCase().includes(query))
    .map(([address, postCount]) => ({ address, postCount, pubkey: pubkeys.get(address) || null }))
    .sort((a, b) => (a.postCount === b.postCount
      ? posterName(a.address).localeCompare(posterName(b.address))
      : b.postCount - a.postCount));
}

// The shell (scope picker + field) is built once per panel so typing never loses focus; only
// the results box below it is rebuilt.
function renderSearchPanel(panel) {
  clearPanelPagerSentinels();
  if (!panelBodyEl.querySelector("[data-kaposts-search-root]")) {
    panelBodyEl.innerHTML = `
      <div class="kaposts-search-root" data-kaposts-search-root>
        ${/* iOS: the search field sits in the navigation bar drawer, above the Posts | People picker. */ ""}
        <input class="kaposts-search-input" type="search" data-kaposts-search-input placeholder="Posts and people" autocomplete="off" spellcheck="false" />
        <div class="kaposts-search-scope" role="tablist">
          <button type="button" data-kaposts-search-scope="posts">Posts</button>
          <button type="button" data-kaposts-search-scope="people">People</button>
        </div>
        <div class="kaposts-search-results" data-kaposts-search-results></div>
      </div>`;
  }
  const input = panelBodyEl.querySelector("[data-kaposts-search-input]");
  if (input && input.value !== panel.query) input.value = panel.query;
  renderSearchResults(panel);
}

function renderSearchResults(panel) {
  const root = panelBodyEl?.querySelector("[data-kaposts-search-root]");
  const results = root?.querySelector("[data-kaposts-search-results]");
  if (!root || !results || activePanel !== panel) return;
  root.querySelectorAll("[data-kaposts-search-scope]").forEach((button) => {
    button.classList.toggle("active", button.dataset.kapostsSearchScope === panel.scope);
  });
  const query = searchQuery(panel);
  const loading = Boolean(panel.pager?.loading);
  const hasMore = Boolean(panel.pager?.hasMore);
  const scannedCount = panel.scanned.length;

  if (!query) {
    results.innerHTML = `
      <div class="no-results-card kaposts-empty">
        <svg class="kaposts-empty-icon" viewBox="0 0 24 24"><path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/></svg>
        <strong>Search KaPosts</strong>
        <span>Find posts by what they say, and people by their name or domain. Only people who have posted appear.</span>
      </div>`;
    return;
  }

  // Says how deep the search has gone, and offers to go deeper. Shown under the results rather
  // than only when empty: a handful of hits does not mean there are no more.
  const depthFooter = hasMore
    ? `<button class="kaposts-search-depth" type="button" data-kaposts-search-more ${loading ? "disabled" : ""}>
         <span>${loading ? "Reading older posts" : "Search older posts"}</span>
         <small>${scannedCount} read</small>
       </button>`
    : panel.loadFailed
      ? `<p class="kaposts-inline-note">Could not read any further just now.</p>`
      : "";

  const rows = panel.scope === "people" ? matchingSearchPeople(panel) : matchingSearchPosts(panel);
  if (rows.length === 0 && !loading) {
    results.innerHTML = `
      <div class="no-results-card kaposts-empty">
        <strong>Nothing found yet</strong>
        <span>${hasMore
          ? `Searched the most recent ${scannedCount} posts. Older ones have not been read yet.`
          : "Searched every post available."}</span>
        ${hasMore ? `<button class="primary-button kaposts-search-keep" type="button" data-kaposts-search-more>Keep looking</button>` : ""}
      </div>`;
    return;
  }
  if (rows.length === 0) {
    // Still reading with nothing matched yet: iOS shows the empty list with only its depth
    // footer ("Reading older posts" / "N read").
    results.innerHTML = depthFooter;
    return;
  }
  results.innerHTML = (panel.scope === "people"
    ? rows.map((person) => `
        <button type="button" class="kaposts-search-row kaposts-search-person" data-kaposts-search-person="${deps.escapeHtml(person.address)}" data-kaposts-search-pubkey="${deps.escapeHtml(person.pubkey || "")}">
          ${posterAvatarHtml(person.address)}
          <span class="kaposts-search-row-main">
            <strong>${deps.escapeHtml(posterName(person.address))}</strong>
            <small>${person.postCount === 1 ? "1 post found" : `${person.postCount} posts found`}</small>
          </span>
          <svg class="kaposts-search-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>
        </button>`)
    : rows.map((post) => `
        <button type="button" class="kaposts-search-row kaposts-search-post" data-kaposts-search-post="${deps.escapeHtml(post.remoteId)}">
          <span class="kaposts-search-row-main">
            <strong>${deps.escapeHtml(posterName(post.posterAddress))}</strong>
            ${/* iOS: the post's plain text in three lines, then how long ago, spelled out */ ""}
            <span class="kaposts-search-snippet plain">${deps.escapeHtml(post.text)}</span>
            <small>${deps.escapeHtml(kapostsLongRelativeTime(post.timestamp))}</small>
          </span>
        </button>`)
  ).join("") + depthFooter;
}

/// The K pubkey a Schnorr address derives ("02" + its x-only key), as @mentions use it (iOS
/// KaPostsAPIClient.kapostPubkey(fromAddress:)); null for anything else.
function kapostPubkeyFromAddress(address) {
  const decoded = decodeAddress(String(address || "").toLowerCase());
  if (!decoded || decoded.version !== AddressVersion.pubKey || decoded.payload.length !== 32) return null;
  return `02${Array.from(decoded.payload, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/// The K pubkey behind an address: "02" or "03" + its x-only key, as the indexer's DATA names it -
/// the key on the person's posts (or replies) - accepted only when its x-only half is the address's. Never the probe: the indexer answers a probe in either parity
/// form (kachat-indexer 12543eb), so returning whichever probe "had data" handed back the 02 guess
/// for an 03 user, and Follow posted it on chain (XP-034; iOS 0a0c914, IOS-099). Null when the data
/// names no key: Follow then stays local-only.
async function resolveKaPostsPubkey(address) {
  const even = kapostPubkeyFromAddress(address);
  if (!even) return null;
  const xOnly = even.slice(2).toLowerCase();
  const named = (key) => {
    const k = String(key || "").trim().toLowerCase();
    return k.length === 66 && (k.startsWith("02") || k.startsWith("03")) && k.slice(2) === xOnly ? k : null;
  };
  const keyIn = (rows) => (rows || []).map((row) => named(row?.userPublicKey)).find(Boolean) || null;
  const candidates = [even.toLowerCase(), `03${xOnly}`];
  for (const candidate of candidates) {
    // iOS asks get-posts with replies included; here replies are their own endpoint
    const posts = await fetchUserPosts({ engine: deps.engine, pubkey: candidate, limit: 1 }).catch(() => null);
    const fromPosts = keyIn(posts?.posts);
    if (fromPosts) return fromPosts;
    const replies = await fetchUserReplies({ engine: deps.engine, pubkey: candidate, limit: 1 }).catch(() => null);
    const fromReplies = keyIn(replies?.posts);
    if (fromReplies) return fromReplies;
  }
  // No profile-details fallback (iOS 21e1c5d): get-user-details echoes back whichever key it was
  // asked with, so it would hand back the probe again. No posts or replies: null.
  return null;
}

async function openPosterProfile(address, passedPubkey) {
  rememberFeedScroll();
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  activePanel = beginPanel({
    type: "profile", address, pubkey: passedPubkey || null, tab: "posts", posts: [], replies: [], details: null, loading: true,
    pagers: { posts: makePager(), replies: makePager() },
  });
  const panel = activePanel;
  renderPanel();
  syncRailActive();
  deps.engine.fetchKnsAddressInfo?.(address).catch(() => null)
    .then(() => deps.engine.fetchKnsAddressProfile?.(address).catch(() => null))
    .then(() => { if (activePanel === panel) renderPanel(); });
  // No pubkey handed over: the address gives the x-only key, but a K key starts with 02 or 03 -
  // try both and keep the one the indexer has data for (iOS XP-034). The panel's pubkey is what
  // Follow and the counts use, so it is never a guess: null when neither has any.
  const pubkey = passedPubkey || await resolveKaPostsPubkey(address);
  if (activePanel !== panel || generation !== panelGeneration) return;
  panel.pubkey = pubkey;
  if (!pubkey) {
    panel.loading = false;
    panel.pagers.posts.hasMore = false;
    panel.pagers.replies.hasMore = false;
    renderPanel();
    return;
  }
  try {
    const [details, content, repliesContent] = await Promise.all([
      fetchKaPostUserDetails({ engine: deps.engine, pubkey }).catch(() => null),
      fetchUserPosts({ engine: deps.engine, pubkey, limit: PAGER_PAGE_SIZE }),
      // Separate endpoint — get-posts never returns replies (see fetchUserPosts' note). A
      // replies failure must not blank the Posts tab.
      fetchUserReplies({ engine: deps.engine, pubkey, limit: PAGER_PAGE_SIZE })
        .catch(() => ({ posts: [], pagination: null })),
    ]);
    if (activePanel !== panel || generation !== panelGeneration) return;
    const mapped = content.posts.map(mapRemotePost).filter(Boolean);
    panel.posts = mapped.filter((p) => !p.parentRemoteId);
    panel.replies = repliesContent.posts.map(mapRemotePost).filter(Boolean);
    panel.details = address === deps.engine.address ? ownProfileDetails(details, pubkey) : details;
    panel.loading = false;
    seedPager(panel.pagers.posts, content.posts, content.pagination);
    seedPager(panel.pagers.replies, repliesContent.posts, repliesContent.pagination);
    renderPanel();
    resolvePosterIdentities([address], () => { if (activePanel === panel) renderPanel(); });
  } catch (error) {
    deps.appendEngineLog?.(`KaPost profile load failed: ${error.message}`);
    if (activePanel === panel) {
      panel.loading = false;
      panel.pagers.posts.hasMore = false;
      panel.pagers.replies.hasMore = false;
      renderPanel();
    }
  }
}

// Your own profile never counts you as your own follower (iOS myProfileSheet .task):
// `followedUser` there means "requester follows user", and with both being you, true is a stale
// on-chain self-follow from before the no-self-follow rule. Shown without it, and one unfollow
// per session scrubs it from the indexer.
const selfUnfollowScrubbed = new Set();
function ownProfileDetails(details, pubkey) {
  if (!details || details.followedUser !== true) return details;
  if (pubkey && !selfUnfollowScrubbed.has(pubkey)) {
    selfUnfollowScrubbed.add(pubkey);
    submitKaPostFollow({ engine: deps.engine, follow: false, followedPubkey: pubkey })
      .then(() => deps.appendEngineLog?.("KaPosts: submitted self-unfollow scrub"))
      .catch((error) => deps.appendEngineLog?.(`KaPosts self-unfollow scrub failed: ${error.message}`));
  }
  return { ...details, followersCount: Math.max(0, (Number(details.followersCount) || 0) - 1) };
}

/** Pull-to-refresh on a profile (iOS profileFeedPage onRefresh): page one of the tab on screen. */
async function refreshProfilePanel(panel) {
  if (!panel?.pubkey) return;
  const tab = panel.tab === "replies" ? "replies" : "posts";
  if (panel.pagers?.[tab]?.loading) return;
  const generation = panelGeneration;
  // A fresh pager: a load-more still in flight on the old one sees it was replaced and drops out.
  const pager = makePager();
  panel.pagers[tab] = pager;
  pager.loading = true;
  renderPanel();
  try {
    const content = tab === "replies"
      ? await fetchUserReplies({ engine: deps.engine, pubkey: panel.pubkey, limit: PAGER_PAGE_SIZE })
      : await fetchUserPosts({ engine: deps.engine, pubkey: panel.pubkey, limit: PAGER_PAGE_SIZE });
    if (activePanel !== panel || generation !== panelGeneration || panel.pagers[tab] !== pager) return;
    const mapped = content.posts.map(mapRemotePost).filter(Boolean);
    panel[tab] = tab === "replies" ? mapped : mapped.filter((post) => !post.parentRemoteId);
    seedPager(pager, content.posts, content.pagination);
    renderPanel();
  } catch (error) {
    deps.appendEngineLog?.(`KaPost profile refresh failed: ${error.message}`);
    if (activePanel === panel && panel.pagers[tab] === pager) {
      pager.loading = false;
      pager.error = userFacingError(error);
      renderPanel();
    }
  }
}

// Followers / Following list, opened by tapping a profile's counts. `parent` carries the profile
// we came from so the panel's Back button returns there instead of dropping to the feed.
// Pages the server list newest-first on its own cursor (iOS KaPostsFollowListView.loadPage).
async function openFollowListPanel({ address, pubkey, mode, parent }) {
  if (!pubkey) { deps.showToast?.("This profile has no public key to look up yet."); return; }
  panelGeneration += 1;
  clearPanelPagerSentinels();
  activePanel = beginPanel({
    type: "followList", mode, address, pubkey, parent: parent || null,
    rows: [], serverRows: [], loading: true, pager: makePager(),
  });
  renderPanel();
  syncRailActive();
  loadMoreFollowList();
}

// The list endpoints return each user under one of several possible pubkey fields.
function followItemPubkey(item) {
  return item?.userPublicKey || item?.publicKey || item?.pubkey
    || item?.followedPubkey || item?.followerPubkey || item?.user || "";
}

/** Follows made on this device that the indexer has not reported yet: a fixed tail after the
 *  server rows, own Following list only (iOS localOnlyEntries). */
function followListLocalTail(panel, known) {
  if (panel.mode !== "following" || panel.address !== deps.engine.address) return [];
  return [...prefs.following]
    .filter((address) => address !== deps.engine.address && !known.has(address))
    .sort()
    .map((address) => ({ address, pubkey: null, timestamp: null }));
}

function loadMoreFollowList() {
  const panel = activePanel;
  if (panel?.type !== "followList" || !panel.pager) return;
  const pager = panel.pager;
  const generation = panelGeneration;
  // Only your OWN list hides you (you never follow yourself); on someone else's list you may
  // legitimately appear, and the row just has no Follow button.
  const ownList = panel.address === deps.engine.address;
  const isStale = () => generation !== panelGeneration || activePanel !== panel || panel.pager !== pager;
  const recompute = () => {
    panel.rows = [...panel.serverRows, ...followListLocalTail(panel, new Set(panel.serverRows.map((row) => row.address)))];
  };
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const page = await fetchFollowListPage({
        engine: deps.engine, pubkey: panel.pubkey, followers: panel.mode === "followers", limit, before,
      });
      return { items: page.users, pagination: page.pagination };
    },
    idOf: (item) => followItemPubkey(item) || item?.address || null,
    absorb: (fresh) => {
      const seen = new Set(panel.serverRows.map((row) => row.address));
      const added = [];
      for (const item of fresh) {
        const rowPubkey = followItemPubkey(item);
        const rowAddress = item?.address || kaspaAddressFromPubkey(deps.engine, rowPubkey) || "";
        if (!rowAddress || seen.has(rowAddress) || (ownList && rowAddress === deps.engine.address)) continue;
        seen.add(rowAddress);
        const timestamp = Number(item?.timestamp || item?.createdAt || item?.followedAt) || null;
        added.push({ address: rowAddress, pubkey: rowPubkey || null, timestamp });
      }
      panel.serverRows = [...panel.serverRows, ...added];
      panel.loading = false;
      recompute();
      renderPanel();
      resolvePosterIdentities(added.map((row) => row.address), () => { if (activePanel === panel) renderPanel(); });
      return added.length;
    },
    isStale,
    onUpdate: () => {
      // A failed first page still shows your local follows rather than an empty screen.
      if (!pager.loading) { panel.loading = false; recompute(); }
      renderPanel();
    },
  });
}

/** Pull-to-refresh on a follow list: back to page one; the rows on screen stay until it lands. */
function refreshFollowList(panel) {
  if (panel?.type !== "followList" || panel.pager?.loading) return;
  panel.pager = makePager();
  panel.serverRows = [];
  return loadMoreFollowList();
}

/** Sentinel hit under a profile's Posts or Replies tab (own profile and other users' alike). */
function loadMoreProfile(tab) {
  const panel = activePanel;
  if (panel?.type !== "profile" || !panel.pubkey) return;
  const pager = panel.pagers?.[tab];
  if (!pager) return;
  const generation = panelGeneration;
  const listKey = tab === "replies" ? "replies" : "posts";
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const result = tab === "replies"
        ? await fetchUserReplies({ engine: deps.engine, pubkey: panel.pubkey, limit, before })
        : await fetchUserPosts({ engine: deps.engine, pubkey: panel.pubkey, limit, before });
      return { items: result.posts, pagination: result.pagination };
    },
    absorb: (fresh) => {
      const mapped = fresh.map(mapRemotePost).filter(Boolean);
      // get-posts is hard-filtered to posts/quotes server-side, but a stray reply would
      // belong on the other tab — the Posts tab shows top-level content only.
      const rows = tab === "replies" ? mapped : mapped.filter((post) => !post.parentRemoteId);
      const known = new Set((panel[listKey] || []).map((post) => post.id));
      const added = rows.filter((post) => !known.has(post.id));
      panel[listKey] = [...(panel[listKey] || []), ...added];
      renderPanel();
      return added.length;
    },
    isStale: () => generation !== panelGeneration
      || activePanel !== panel
      || panel.pagers?.[tab] !== pager // a refresh started page one over again
      || (panel.tab === "replies" ? "replies" : "posts") !== tab,
    onUpdate: () => renderPanel(),
  });
}

// ---------------------------------------------------------------------------
// Background notification polling (iOS parity: KaPosts activity pings, gated by
// Settings > Notifications > KaPosts per-type toggles via
// deps.shouldNotifyKaPostsAction). Polls the same get-notifications endpoint
// the panel uses, dedupes by notification id (account-scoped, persisted), and
// posts a desktop notification per fresh item. First run for an account seeds
// the baseline silently so enabling never blasts history. Suppressed entirely
// in Child Mode (deps.kaPostsSuppressed), matching the hidden tab.
// ---------------------------------------------------------------------------

const KAPOSTS_SEEN_NOTIFS_KEY = "kachat-kaposts-seen-notifications-v1";
const KAPOSTS_NOTIF_POLL_MS = 90_000;
let kaPostsNotifPollTimer = 0;

// Unseen KaPosts activity, per account (iOS KaPostsNotificationCenter). Bumped by the poller
// for every arrival that passes the same filters as a ping, cleared the moment the list opens:
// opening the list IS seeing them. Capped in the label rather than the stored value, so the
// real number survives a long absence and only its rendering is abbreviated.
const KAPOSTS_UNSEEN_KEY = "kachat-kaposts-unseen-v1";
function loadUnseenKaPostsCount() {
  try { return Math.max(0, Number(localStorage.getItem(deps.accountScopedKey(KAPOSTS_UNSEEN_KEY))) || 0); }
  catch { return 0; }
}
function saveUnseenKaPostsCount(count) {
  try { localStorage.setItem(deps.accountScopedKey(KAPOSTS_UNSEEN_KEY), String(Math.max(0, count | 0))); }
  catch {}
}
function recordUnseenKaPostsArrivals(count) {
  if (count <= 0) return;
  saveUnseenKaPostsCount(loadUnseenKaPostsCount() + count);
  syncRailBadge();
}
function markAllKaPostsNotificationsSeen() {
  if (loadUnseenKaPostsCount() === 0) return;
  saveUnseenKaPostsCount(0);
  syncRailBadge();
}
export function kaPostsUnseenCount() {
  return deps ? loadUnseenKaPostsCount() : 0;
}
function syncRailBadge() {
  const button = document.querySelector('[data-kaposts-rail="notifications"]');
  if (!button || !deps) return;
  const count = loadUnseenKaPostsCount();
  let badge = button.querySelector("[data-kaposts-rail-badge]");
  if (!count) { badge?.remove(); button.setAttribute("aria-label", "Notifications"); return; }
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "kaposts-rail-badge";
    badge.setAttribute("data-kaposts-rail-badge", "");
    button.appendChild(badge);
  }
  badge.textContent = count > 99 ? "99+" : String(count);
  button.setAttribute("aria-label", `Notifications, ${count} unseen`);
}

function loadSeenKaPostNotificationIds() {
  try { return JSON.parse(localStorage.getItem(deps.accountScopedKey(KAPOSTS_SEEN_NOTIFS_KEY)) || "[]"); }
  catch { return []; }
}

function saveSeenKaPostNotificationIds(ids) {
  try { localStorage.setItem(deps.accountScopedKey(KAPOSTS_SEEN_NOTIFS_KEY), JSON.stringify(ids.slice(-300))); }
  catch {}
}

/** "tipped your post: 1.5 KAS" (iOS 09f6ae0): contentType "tip" rows carry what the tip paid you. */
function kaPostsTipActionText(n) {
  const amount = n?.tipAmountSompi;
  return amount != null && amount !== "" ? `tipped your post: ${kasTextFromSompi(amount)} ${KAS_UNIT}` : "tipped your post";
}

function kaPostsNotificationAction(n, text) {
  if (n.contentType === "vote") return n.voteType === "downvote" ? "disliked your post" : "liked your post";
  if (n.contentType === "tip") return kaPostsTipActionText(n);
  if (n.contentType === "reply") return "replied to your post";
  if (n.contentType === "quote") return text ? "quoted your post" : "reposted your post";
  if (n.contentType === "follow") return "followed you";
  if (n.contentType === "mention") return "mentioned you in a post";
  return "interacted with your post";
}

async function pollKaPostNotificationsForPings() {
  if (!deps?.engine?.address) return;
  if (deps.kaPostsSuppressed?.()) return;
  let raw;
  try { raw = (await fetchKaPostNotifications({ engine: deps.engine })).notifications; } catch { return; }
  if (!Array.isArray(raw) || !raw.length) return;

  const my = deps.engine.address;
  const seen = loadSeenKaPostNotificationIds().map(String);
  const seenSet = new Set(seen);
  const firstRun = seen.length === 0;
  const fresh = [];
  for (const n of raw) {
    const id = String(n?.id || "");
    if (!id || seenSet.has(id)) continue;
    seenSet.add(id);
    seen.push(id);
    if (firstRun) continue; // baseline seeding — history never notifies
    const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
    if (!actorAddress || actorAddress === my || isHiddenAuthor(actorAddress)) continue;
    // Warm the KNS cache so posterName can use the actor's domain (peek is cache-only;
    // a cold cache would fall back to the short address even when they own a domain).
    try { await deps.engine.refreshKnsIfNeeded?.([actorAddress]); } catch { /* name falls back */ }
    // The global notification center lists every fresh KaPosts action (mentions included),
    // independent of the per-type OS-ping gate below.
    const centerText = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
    deps.recordGlobalNotification?.({
      source: "kaposts",
      id: `kaposts-${n.id}`,
      title: `${posterName(actorAddress)} ${kaPostsNotificationAction(n, centerText)}`,
      body: centerText ? `"${centerText.slice(0, 90)}${centerText.length > 90 ? "…" : ""}"` : "",
      timestamp: Number(n.timestamp) || Date.now(),
      targetKind: "kaposts",
      // Clicking the bell row deep-opens the exact post/comment (same per-kind
      // target rule as the in-app notifications panel).
      targetId: notificationTargetTxId(n, centerText) || undefined,
    });
    // Per-type gate (Settings > Notifications > KaPosts). Disabled types are
    // silently skipped — never queued for later. Unknown kinds always notify.
    if (deps.shouldNotifyKaPostsAction && !deps.shouldNotifyKaPostsAction(n.contentType, n.voteType)) continue;
    fresh.push({ n, actorAddress });
  }
  saveSeenKaPostNotificationIds(seen);
  // Counted only while the list is closed: with it open, the rows are already in front of you.
  if (activePanel?.type !== "notifications") recordUnseenKaPostsArrivals(fresh.length);

  for (const { n, actorAddress } of fresh.slice(0, 5)) {
    const text = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
    const target = notificationTargetTxId(n, text);
    if (activePanel?.type === "notifications" && document.hasFocus()) continue; // the screen itself is the notification
    deps.postDesktopNotification?.({
      title: "KaPosts",
      body: `${posterName(actorAddress)} ${kaPostsNotificationAction(n, text)}`,
      tag: `kachat-kaposts-${n.id}`,
      // A tap that comes back after the app was closed has no closure to call: the route opens
      // the post (or the KaPosts tab) instead.
      route: target ? { kind: "kapost", txId: target } : { kind: "tab", tab: "kaposts" },
      // Land on the exact post/comment: switch to the KaPosts tab first (the
      // notification can arrive while another tab is active), then deep-open.
      onClick: () => {
        deps.openKaPostsTab?.();
        if (target) resolveAndOpenPost(target, { parentRemoteIdHint: notificationParentTxId(n) });
        else openNotificationsPanel();
      },
    });
  }
}

/** Which post/comment a notification should open — same per-kind rule as mapNotificationRow. */
function notificationTargetTxId(n, decodedText = "") {
  if (n.contentType === "reply") return n.id;
  if (n.contentType === "quote") return decodedText ? n.id : (n.contentId || null);
  if (n.contentType === "follow") return null;
  // A mention's acting content IS the post/comment that mentions you, so when the
  // indexer leaves contentId empty (nothing of YOURS was acted on), fall back to
  // the notification's own txid — without this, mention rows had no target at all.
  if (n.contentType === "mention") return n.contentId || n.id || null;
  return n.contentId || null; // vote, unknown kinds
}

/**
 * A reply notification's target is the REPLY, and the conversation it belongs to is the
 * notification's contentId — the post of yours that was replied to. Handing that through as
 * the parent hint means the parent thread opens even when the indexer's mapping for the reply
 * itself lost parentPostId (iOS parentRemoteIdHint).
 */
function notificationParentTxId(n) {
  return n?.contentType === "reply" && n.contentId ? String(n.contentId) : null;
}

/** Deep-open a post/comment by txid from OUTSIDE this module (the global bell center). */
// What a shared post link shows before it is opened (iOS KaPostLinkPreviewCache): the author,
// a snippet, and whether it is a reply or a quote. Resolved once per post id.
const kaPostLinkPreviews = new Map();
const kaPostLinkPreviewPending = new Map();
function kaPostLinkPreviewEntry(post) {
  if (!post) return null;
  const text = String(post.text || "").replace(/\s+/g, " ").trim();
  return {
    authorName: posterName(post.posterAddress),
    authorAddress: post.posterAddress,
    avatarHtml: posterAvatarHtml(post.posterAddress),
    snippet: text.length > 140 ? `${text.slice(0, 137).trimEnd()}...` : text,
    action: post.parentRemoteId ? "reply" : post.quoted ? "quote" : "post",
  };
}
export function peekKaPostLinkPreview(txId) {
  const id = String(txId || "");
  if (!id || !deps) return null;
  if (kaPostLinkPreviews.has(id)) return kaPostLinkPreviews.get(id);
  const local = findPostByRemoteId(id);
  if (local) { const entry = kaPostLinkPreviewEntry(local); kaPostLinkPreviews.set(id, entry); return entry; }
  return null;
}
export async function resolveKaPostLinkPreview(txId) {
  const id = String(txId || "");
  if (!id || !deps) return null;
  const known = peekKaPostLinkPreview(id);
  if (known) return known;
  if (kaPostLinkPreviewPending.has(id)) return kaPostLinkPreviewPending.get(id);
  const promise = indexerPost(id).then((post) => {
    const entry = kaPostLinkPreviewEntry(post);
    if (entry) kaPostLinkPreviews.set(id, entry);
    return entry;
  }).finally(() => kaPostLinkPreviewPending.delete(id));
  kaPostLinkPreviewPending.set(id, promise);
  return promise;
}

export function openKaPostFromNotification(txId) {
  if (!deps) return;
  if (txId) resolveAndOpenPost(txId);
  else openNotificationsPanel();
}

function startKaPostsNotificationPolling() {
  if (kaPostsNotifPollTimer) window.clearInterval(kaPostsNotifPollTimer);
  kaPostsNotifPollTimer = window.setInterval(() => { if (!document.hidden) pollKaPostNotificationsForPings(); }, KAPOSTS_NOTIF_POLL_MS);
  window.setTimeout(pollKaPostNotificationsForPings, 10_000);
}

/** One indexer notification -> one panel row, or null when it must not be shown. */
// The kind badge on a notification's avatar (iOS Item.Kind.icon/tint).
const NOTIFICATION_KIND_ICONS = {
  like: `<svg viewBox="0 0 24 24"><path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>`,
  dislike: `<svg viewBox="0 0 24 24"><path d="M7.5 15h2.25m8.024-9.75c.011.05.028.1.052.148.591 1.2.924 2.55.924 3.977a8.96 8.96 0 0 1-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398-.306.774-1.086 1.227-1.918 1.227h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 0 0 .303-.54m.023-8.25H16.48a4.5 4.5 0 0 1-1.423-.23l-3.114-1.04a4.5 4.5 0 0 0-1.423-.23H6.504c-.618 0-1.217.247-1.605.729A11.95 11.95 0 0 0 2.25 12c0 .434.023.863.068 1.285C2.427 14.306 3.346 15 4.372 15h3.126c.618 0 .991.724.725 1.282A7.471 7.471 0 0 0 7.5 19.5a2.25 2.25 0 0 0 2.25 2.25.75.75 0 0 0 .75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 0 0 2.86-2.4c.498-.634 1.226-1.08 2.032-1.08h.384"/></svg>`,
  reply: `<svg viewBox="0 0 24 24"><path d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.282 48.282 0 0 0 5.68-.494c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg>`,
  quote: `<svg viewBox="0 0 24 24"><path d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"/></svg>`,
  repost: `<svg viewBox="0 0 24 24"><path d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"/></svg>`,
  follow: `<svg viewBox="0 0 24 24"><path d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM4 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 10.374 21c-2.331 0-4.512-.645-6.374-1.766Z"/></svg>`,
  mention: `<svg viewBox="0 0 24 24"><path d="M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Zm0 0c0 1.657 1.007 3 2.25 3S21 13.657 21 12a9 9 0 1 0-2.636 6.364"/></svg>`,
  other: `<svg viewBox="0 0 24 24"><path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"/></svg>`,
};

function mapNotificationRow(n) {
  const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
  if (!actorAddress || actorAddress === deps.engine.address || isHiddenAuthor(actorAddress)) return null;
  // Settings > Notifications > KaPosts: anything switched off sends no notification and does
  // not appear in this list either.
  if (deps.shouldNotifyKaPostsAction && !deps.shouldNotifyKaPostsAction(n.contentType, n.voteType)) return null;
  const text = stripKaChatMarker(n.postContent ? (decodePostContent({ postContent: n.postContent }) || "") : "").trim();
  let action = "interacted with your post";
  let targetTxId = n.contentId || null;
  if (n.contentType === "vote") action = n.voteType === "downvote" ? "disliked your post" : "liked your post";
  else if (n.contentType === "reply") { action = "replied to your post"; targetTxId = n.id; }
  else if (n.contentType === "quote") {
    action = text ? "quoted your post" : "reposted your post";
    targetTxId = text ? n.id : n.contentId;
  } else if (n.contentType === "follow") { action = "followed you"; targetTxId = null; }
  else if (n.contentType === "mention") { action = "mentioned you in a post"; targetTxId = n.contentId || n.id; }
  // A tip opens the tipped post (contentId), iOS 09f6ae0.
  else if (n.contentType === "tip") { action = kaPostsTipActionText(n); targetTxId = n.contentId || null; }
  const kind = n.contentType === "vote" ? (n.voteType === "downvote" ? "dislike" : "like")
    : n.contentType === "quote" ? (text ? "quote" : "repost")
    : ["reply", "follow", "mention", "tip"].includes(n.contentType) ? n.contentType : "other";
  return {
    kind,
    id: n.id, actorAddress, action, snippet: text || null,
    timestamp: Number(n.timestamp) || Date.now(),
    targetTxId, parentTxId: notificationParentTxId(n),
  };
}

async function openNotificationsPanel() {
  rememberFeedScroll();
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  activePanel = beginPanel({ type: "notifications", items: [], loading: true, pager: makePager({ pageSize: PAGER_THREAD_PAGE_SIZE }) });
  const panel = activePanel;
  renderPanel();
  syncRailActive();
  // Opening the list IS seeing them - cleared on open rather than on close so the badge does
  // not sit there while you read.
  markAllKaPostsNotificationsSeen();
  if (generation !== panelGeneration) return;
  await loadNotificationsFirstPage(panel);
}

/** Page one of the notification stream - the open and the pull-to-refresh (iOS loadPage(reset:)). */
async function loadNotificationsFirstPage(panel) {
  if (panel?.type !== "notifications") return;
  const generation = panelGeneration;
  // A fresh pager: a load-more still in flight on the old one sees it was replaced and drops out.
  const pager = makePager({ pageSize: PAGER_THREAD_PAGE_SIZE });
  panel.pager = pager;
  panel.loading = true;
  renderPanel();
  try {
    const page = await fetchKaPostNotifications({ engine: deps.engine, limit: PAGER_THREAD_PAGE_SIZE });
    if (activePanel !== panel || generation !== panelGeneration || panel.pager !== pager) return;
    panel.items = page.notifications.map(mapNotificationRow).filter(Boolean);
    panel.loading = false;
    seedPager(pager, page.notifications, page.pagination);
    // Everything now on screen counts as seen - the background poller will not ping for it
    // later (iOS markSeen(upTo:), only the first, newest page advances it).
    const seen = loadSeenKaPostNotificationIds().map(String);
    const seenSet = new Set(seen);
    for (const n of page.notifications) {
      const id = String(n?.id || "");
      if (id && !seenSet.has(id)) { seenSet.add(id); seen.push(id); }
    }
    saveSeenKaPostNotificationIds(seen);
    renderPanel();
    resolvePosterIdentities(panel.items.map((item) => item.actorAddress), () => {
      if (activePanel === panel) renderPanel();
    });
  } catch (error) {
    deps.appendEngineLog?.(`KaPost notifications load failed: ${error.message}`);
    if (activePanel === panel && panel.pager === pager) { panel.loading = false; pager.hasMore = false; renderPanel(); }
  }
}

/** Sentinel hit at the bottom of the notifications panel. */
function loadMoreNotifications() {
  const panel = activePanel;
  if (panel?.type !== "notifications" || !panel.pager) return;
  const generation = panelGeneration;
  const pager = panel.pager;
  return runPager(pager, {
    fetchPage: async (before, limit) => {
      const page = await fetchKaPostNotifications({ engine: deps.engine, limit, before });
      return { items: page.notifications, pagination: page.pagination };
    },
    absorb: (fresh) => {
      // Own actions and muted/blocked actors drop out here — that filtering is why the
      // shrinkage loop keeps pulling instead of settling for one page.
      const rows = fresh.map(mapNotificationRow).filter(Boolean);
      panel.items = [...panel.items, ...rows];
      renderPanel();
      resolvePosterIdentities(rows.map((item) => item.actorAddress), () => {
        if (activePanel === panel) renderPanel();
      });
      return rows.length;
    },
    isStale: () => generation !== panelGeneration || activePanel !== panel || panel.pager !== pager,
    onUpdate: () => renderPanel(),
  });
}

/** Post Activity's kinds, in card order (iOS KaPostEngagementView.EngagementTab). */
const ENGAGEMENT_KINDS = [
  { key: "likes", label: "Likes" },
  { key: "dislikes", label: "Dislikes" },
  { key: "reposts", label: "Reposts" },
  { key: "quotes", label: "Quotes" },
  { key: "tips", label: "Tips" },
];

// The cards' marks, filled as iOS's heart.fill / hand.thumbsdown.fill / quote.bubble.fill; the
// repost arrows as the action bar's; the Kaspa logo for tips.
const ENGAGEMENT_KIND_ICONS = {
  likes: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"/></svg>`,
  dislikes: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" d="M15.73 5.5h1.035A7.465 7.465 0 0 1 18 9.625a7.465 7.465 0 0 1-1.235 4.125h-.148c-.806 0-1.534.446-2.031 1.08a9.04 9.04 0 0 1-2.861 2.4c-.723.384-1.35.956-1.653 1.715a4.499 4.499 0 0 0-.322 1.672v.633A.75.75 0 0 1 9 22a2.25 2.25 0 0 1-2.25-2.25c0-1.152.26-2.243.723-3.218.266-.558-.107-1.282-.725-1.282H3.622c-1.026 0-1.945-.694-2.054-1.715A12.137 12.137 0 0 1 1.5 12.25c0-2.848.992-5.464 2.649-7.521C4.537 4.247 5.136 4 5.754 4H9.77a4.5 4.5 0 0 1 1.423.23l3.114 1.04a4.5 4.5 0 0 0 1.423.23ZM21.669 14.023c.536-1.362.831-2.845.831-4.398 0-1.22-.182-2.398-.52-3.507-.26-.85-1.084-1.368-1.973-1.368H19.1c-.445 0-.72.498-.523.898.591 1.2.924 2.55.924 3.977a8.958 8.958 0 0 1-1.302 4.666c-.245.403.028.959.5.959h1.053c.832 0 1.612-.453 1.918-1.227Z"/></svg>`,
  reposts: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="stroke" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"/></svg>`,
  quotes: `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="fill" fill-rule="evenodd" d="M4.848 2.771A49.144 49.144 0 0 1 12 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 0 1-3.476.383.39.39 0 0 0-.297.17l-2.755 4.133a.75.75 0 0 1-1.248 0l-2.755-4.133a.39.39 0 0 0-.297-.17 48.9 48.9 0 0 1-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.68 3.348-3.97ZM7.6 7h3.2v3.2c0 1.9-1 3.2-2.7 3.8l-.5-1.1c.8-.35 1.3-1 1.4-1.8H7.6ZM13.2 7h3.2v3.2c0 1.9-1 3.2-2.7 3.8l-.5-1.1c.8-.35 1.3-1 1.4-1.8h-1.4Z"/></svg>`,
};

function engagementKindIconHtml(key) {
  return key === "tips" ? `<img src="${kaspaLogoUrl}" alt="" aria-hidden="true" />` : (ENGAGEMENT_KIND_ICONS[key] || "");
}

/**
 * A card's number (iOS countText). Likes, dislikes and tips also have the post's own counters, so
 * the larger of those and the people loaded so far; reposts and quotes are counted from the list,
 * with a "+" while more pages are still to load. An en dash until the first page (or, for tips,
 * the tips list) is in, unless the post's own counter already has a number.
 */
function engagementCountText(panel, lists, post, key) {
  const dash = "–";
  if (key === "tips") {
    const counter = Math.max(0, Number(post?.tips) || 0);
    return panel.tipsLoaded || counter > 0 ? String(Math.max(counter, (panel.tips || []).length)) : dash;
  }
  const loaded = (lists[key] || []).length;
  const firstPageIn = !panel.loading || !panel.postTxId;
  if (key === "likes" || key === "dislikes") {
    const counter = Math.max(0, Number(post?.[key]) || 0);
    return firstPageIn || counter > 0 ? String(Math.max(counter, loaded)) : dash;
  }
  if (!firstPageIn) return dash;
  return panel.pager?.hasMore && loaded > 0 ? `${loaded}+` : String(loaded);
}

/** Distributes engagement rows into the four tab lists; returns how many landed per tab. */
function absorbEngagementRows(lists, rows) {
  const counts = { likes: 0, dislikes: 0, reposts: 0, quotes: 0 };
  for (const row of rows || []) {
    const actorAddress = kaspaAddressFromPubkey(deps.engine, row.actorPubkey);
    if (!actorAddress) continue;
    const entry = { actionTxId: row.actionTxId, actorAddress, timestamp: Number(row.timestamp) || Date.now() };
    const bucket = row.kind === "upvote" ? "likes"
      : row.kind === "downvote" ? "dislikes"
        : row.kind === "repost" ? "reposts"
          : row.kind === "quote" ? "quotes" : null;
    if (!bucket) continue;
    lists[bucket].push(entry);
    counts[bucket] += 1;
  }
  return counts;
}

async function openEngagementPanel(post) {
  panelGeneration += 1;
  clearPanelPagerSentinels();
  const generation = panelGeneration;
  // Post Activity opened from inside a thread presents OVER that thread and returns to it on
  // Back (iOS threadEngagementTarget); from the feed it takes the viewport as before.
  activePanel = beginPanel({
    // tab: null = the count cards; a kind's key = that kind's list (iOS 8ffa130)
    type: "engagement", postId: post.id, postTxId: post.remoteId, tab: null, lists: null, loading: true,
    pager: makePager({ pageSize: PAGER_THREAD_PAGE_SIZE }),
    // the Tips tab's own list (iOS 8015069)
    tips: [], tipsLoaded: false, tipsError: "", tipsPager: makePager({ pageSize: KAPOSTS_TIPPERS_PAGE_SIZE }),
  });
  const panel = activePanel;
  renderPanel();
  loadFirstTips(panel);
  const lists = { likes: [], dislikes: [], reposts: [], quotes: [] };
  try {
    const page = await fetchPostEngagement({
      engine: deps.engine, postId: post.remoteId, limit: PAGER_THREAD_PAGE_SIZE,
    });
    absorbEngagementRows(lists, page.engagement);
    seedPager(panel.pager, page.engagement, page.pagination, (row) => row?.actionTxId);
    resolvePosterIdentities(
      Object.values(lists).flat().map((entry) => entry.actorAddress),
      () => { if (activePanel === panel) renderPanel(); },
    );
  } catch (error) {
    // Older deployments: derive from the notification stream (own posts only) — a one-shot
    // list with no cursor of its own, so paging stops here.
    panel.pager.hasMore = false;
    if (post.posterAddress === deps.engine.address) {
      try {
        const raw = (await fetchKaPostNotifications({ engine: deps.engine })).notifications;
        for (const n of raw) {
          if (n.contentId !== post.remoteId) continue;
          const actorAddress = kaspaAddressFromPubkey(deps.engine, n.userPublicKey);
          if (!actorAddress) continue;
          const entry = { actionTxId: n.id, actorAddress, timestamp: Number(n.timestamp) || Date.now() };
          if (n.contentType === "vote") {
            if (n.voteType === "upvote") lists.likes.push(entry);
            else if (n.voteType === "downvote") lists.dislikes.push(entry);
          } else if (n.contentType === "quote") {
            const text = stripKaChatMarker(decodePostContent({ postContent: n.postContent }) || "").trim();
            (text ? lists.quotes : lists.reposts).push(entry);
          }
        }
      } catch { /* leave empty */ }
    }
  }
  if (activePanel !== panel || generation !== panelGeneration) return;
  panel.lists = lists;
  panel.loading = false;
  renderPanel();
}

// ---------------------------------------------------------------------------
// Tips of a post (KAPOSTS_INDEXER.md 5.11): Post Activity's Tips tab (iOS 8015069) and the list
// your own post's tip count opens (iOS a6bd60a KaPostTippersView). Both page get-post-tippers,
// newest first: who tipped, how much and when.
// ---------------------------------------------------------------------------

const KAPOSTS_TIPPERS_PAGE_SIZE = 50;

function mapTipperRow(row) {
  const actorAddress = kaspaAddressFromPubkey(deps.engine, row?.userPublicKey);
  if (!actorAddress || !row?.id) return null;
  return { id: String(row.id), actorAddress, amountSompi: row.amountSompi ?? 0, timestamp: Number(row.timestamp) || Date.now() };
}

/** The rows of a panel holding { tips, tipsLoaded, tipsError }. `showError`: the Tips list says
 *  why it is empty; Post Activity's tab just says there are none (as iOS). */
function tipperRowsHtml(panel, { showError = false } = {}) {
  if (!panel.tipsLoaded) return `<div class="kaposts-feed-status">Loading…</div>`;
  if (!panel.tips.length) {
    return `<div class="no-results-card"><strong>${deps.escapeHtml((showError && panel.tipsError) || "No tips yet.")}</strong></div>`;
  }
  return panel.tips.map((tip) => `
    <div class="kaposts-notification-row">
      ${posterAvatarHtml(tip.actorAddress)}
      <div class="kaposts-notification-main">
        <span><strong>${deps.escapeHtml(posterName(tip.actorAddress))}</strong></span>
        <span class="kaposts-cell-time">${deps.escapeHtml(formatRelativeTime(tip.timestamp))}</span>
      </div>
      <span class="kaposts-tipper-amount">${deps.escapeHtml(`${kasTextFromSompi(tip.amountSompi)} ${KAS_UNIT}`)}</span>
    </div>`).join("");
}

async function loadFirstTips(panel) {
  const generation = panelGeneration;
  const isStale = () => generation !== panelGeneration || activePanel !== panel;
  if (!panel.postTxId) { panel.tipsLoaded = true; panel.tipsPager.hasMore = false; return; }
  try {
    const page = await fetchPostTippers({ postId: panel.postTxId, limit: KAPOSTS_TIPPERS_PAGE_SIZE });
    if (isStale()) return;
    panel.tips = page.tippers.map(mapTipperRow).filter(Boolean);
    seedPager(panel.tipsPager, page.tippers, page.pagination);
    resolvePosterIdentities(panel.tips.map((tip) => tip.actorAddress), () => { if (activePanel === panel) renderPanel(); });
  } catch (error) {
    if (isStale()) return;
    panel.tipsError = userFacingError(error);
    panel.tipsPager.hasMore = false;
  }
  panel.tipsLoaded = true;
  renderPanel();
}

function loadMoreTips() {
  const panel = activePanel;
  if (!panel?.tipsPager || !panel.postTxId) return;
  const generation = panelGeneration;
  return runPager(panel.tipsPager, {
    fetchPage: async (before, limit) => {
      const page = await fetchPostTippers({ postId: panel.postTxId, limit, before });
      return { items: page.tippers, pagination: page.pagination };
    },
    absorb: (fresh) => {
      const rows = fresh.map(mapTipperRow).filter(Boolean);
      panel.tips = [...panel.tips, ...rows];
      renderPanel();
      resolvePosterIdentities(rows.map((tip) => tip.actorAddress), () => { if (activePanel === panel) renderPanel(); });
      return rows.length;
    },
    isStale: () => generation !== panelGeneration || activePanel !== panel,
    onUpdate: () => renderPanel(),
  });
}

function openTippersPanel(post) {
  rememberFeedScroll();
  panelGeneration += 1;
  clearPanelPagerSentinels();
  activePanel = beginPanel({
    type: "tippers", postId: post.id, postTxId: post.remoteId,
    tips: [], tipsLoaded: false, tipsError: "", tipsPager: makePager({ pageSize: KAPOSTS_TIPPERS_PAGE_SIZE }),
  });
  const panel = activePanel;
  renderPanel();
  loadFirstTips(panel);
}

/**
 * Sentinel hit under a "who liked / reposted" list. One cursor covers the mixed stream the
 * indexer returns, so a page feeds all four tabs at once; only rows landing on the tab the
 * user is looking at count towards the target.
 */
function loadMoreEngagement() {
  const panel = activePanel;
  if (panel?.type !== "engagement" || !panel.pager || !panel.postTxId) return;
  const generation = panelGeneration;
  return runPager(panel.pager, {
    idOf: (row) => row?.actionTxId,
    fetchPage: async (before, limit) => {
      const page = await fetchPostEngagement({
        engine: deps.engine, postId: panel.postTxId, limit, before,
      });
      return { items: page.engagement, pagination: page.pagination };
    },
    absorb: (fresh) => {
      const lists = panel.lists || (panel.lists = { likes: [], dislikes: [], reposts: [], quotes: [] });
      const counts = absorbEngagementRows(lists, fresh);
      renderPanel();
      resolvePosterIdentities(
        fresh.map((row) => kaspaAddressFromPubkey(deps.engine, row.actorPubkey)),
        () => { if (activePanel === panel) renderPanel(); },
      );
      return counts[panel.tab || "likes"] || 0;
    },
    isStale: () => generation !== panelGeneration || activePanel !== panel,
    onUpdate: () => renderPanel(),
  });
}

// ---------------------------------------------------------------------------
// Popovers (repost/quote chooser + per-post ⋯ menu)
// ---------------------------------------------------------------------------

function setKaPostsScrollLock(locked) {
  document.querySelector('[data-app-tab-screen="kaposts"]')?.classList.toggle("scroll-locked", locked);
}

function closePopover() {
  if (popoverEl) { popoverEl.hidden = true; popoverEl.innerHTML = ""; }
  setKaPostsScrollLock(false);
}

function openPopover(anchor, itemsHtml) {
  if (!popoverEl || !anchor) return;
  popoverEl.innerHTML = itemsHtml;
  popoverEl.hidden = false;
  const screenRect = popoverEl.offsetParent?.getBoundingClientRect?.() || { left: 0, top: 0 };
  const rect = anchor.getBoundingClientRect();
  popoverEl.style.left = `${Math.max(8, rect.left - screenRect.left - 120)}px`;
  popoverEl.style.top = `${rect.bottom - screenRect.top + 6}px`;
}

// A menu row that says what happens, not just the verb (iOS ActionSheetRow).
function popoverRowHtml({ action, id, title, subtitle, danger = false, extra = "" }) {
  return `<button type="button" class="kaposts-pop-row${danger ? " danger" : ""}" data-kaposts-pop="${deps.escapeHtml(String(action))}" data-kaposts-pop-id="${deps.escapeHtml(String(id))}" ${extra}>
    <strong>${deps.escapeHtml(title)}</strong>${subtitle ? `<small>${deps.escapeHtml(subtitle)}</small>` : ""}
  </button>`;
}

// iOS RepostActionsSheet: when the post is already reposted the first row offers to take it back.
function openRepostPopover(anchor, post) {
  const isReposted = post.repostedByMe === true;
  openPopover(anchor, `
    <div class="kaposts-pop-title">${isReposted ? "Reposted" : "Repost"}</div>
    ${popoverRowHtml({
      action: "repost", id: post.id,
      title: isReposted ? "Undo Repost" : "Repost",
      subtitle: isReposted ? "Removes it from your profile." : "Shares it to your followers as-is.",
      danger: isReposted,
    })}
    ${popoverRowHtml({ action: "quote", id: post.id, title: "Quote", subtitle: "Adds your own words above it." })}`);
}

function openMorePopover(anchor, post) {
  const isMine = post.posterAddress === deps.engine.address;
  // Bookmark and Share are their own buttons on every post's action bar (matches iOS), so they
  // are not in the ⋯ menu.
  // The name is in the label ("Mute alice"), as iOS words it: a bare "Mute" on a busy feed
  // leaves you checking which post the menu came from.
  const name = posterName(post.posterAddress);
  // The same half sheet every other menu in the app uses, each row saying what it does (iOS
  // e9fa63e), rather than a popover of bare labels.
  void anchor;
  // iOS overflowSheet, in its order: Edit (on chain, settled and inside the two-hour window),
  // Post Activity, Delete (on chain, settled, not already going), then for someone else's post
  // Report, Mute and Block.
  const options = [];
  const editLeft = KAPOSTS_EDIT_WINDOW_MS - (Date.now() - post.timestamp);
  if (isMine && post.remoteId && post.delivery === "sent" && editLeft > 0) {
    options.push({ id: "edit", title: "Edit", subtitle: `Change the text. Posts can be edited for two hours; after that they stay as they are. ${kapostsEditWindowText(editLeft)}.` });
  }
  if (post.remoteId) options.push({ id: "activity", title: "Post Activity", subtitle: "Who liked, disliked, reposted and quoted this post." });
  if (isMine && post.remoteId && post.delivery === "sent" && !post.pendingDeletion && !pendingActions.has(`delete:${post.id}`)) {
    options.push({ id: "delete", title: "Delete", subtitle: "Removes this post everywhere. You have five seconds to undo.", destructive: true });
  }
  if (!isMine) {
    // Reporting (iOS dd58e26): the post goes to support by email. Posts are on a public chain and
    // cannot be taken down, so Mute and Block under it are the remedies that act at once.
    options.push({ id: "report", title: "Report", subtitle: "Tell KaChat about abusive or objectionable content. Opens an email with this post attached.", destructive: true });
    options.push({ id: "mute", title: `Mute ${name}`, subtitle: "Hides their posts everywhere. They can still interact with you." });
    options.push({ id: "block", title: `Block ${name}`, subtitle: "Hides their posts and stops them interacting with you.", destructive: true });
  }
  if (!options.length) return;
  if (typeof deps.chooseDialog !== "function") {
    openPopover(anchor, options.map((o) => `<button type="button" data-kaposts-pop="${deps.escapeHtml(String(o.id))}" data-kaposts-pop-id="${deps.escapeHtml(String(post.id))}"${o.destructive ? ' class="danger"' : ""}>${deps.escapeHtml(o.title)}</button>`).join(""));
    return;
  }
  deps.chooseDialog({ title: isMine ? "Your post" : name, options }).then((choice) => {
    if (choice) handlePopoverAction(choice, post);
  });
}

function reportPost(post) {
  const body = [
    "I want to report this post.",
    "",
    `Post: ${post.remoteId || "not yet on chain"}`,
    `Author: ${post.posterAddress}`,
    `Text: ${String(post.text || "").slice(0, 500)}`,
    "",
    "What is wrong with it:",
    "",
  ].join("\n");
  const link = document.createElement("a");
  link.href = `mailto:kaspasilver@gmail.com?subject=${encodeURIComponent("KaPosts report")}&body=${encodeURIComponent(body)}`;
  link.click();
}

function handlePopoverAction(action, post) {
  closePopover();
  if (!post) return;
  if (action === "repost") scheduleRepost(post);
  else if (action === "quote") openComposer(post);
  else if (action === "share") {
    // The bare kachat.app link, nothing else: it unfurls the post's preview by itself, and
    // every paste target wants a URL, not a paragraph (iOS 1c72cd3, 688a02e).
    navigator.clipboard?.writeText(postShareLink(post.remoteId));
    deps.showToast?.("Link copied");
  } else if (action === "activity") openEngagementPanel(post);
  else if (action === "report") reportPost(post);
  else if (action === "edit") openComposer(null, { editTarget: post });
  else if (action === "delete") scheduleDelete(post);
  else if (action === "bookmark") { mutatePost(post.id, (p) => { p.bookmarkedByMe = !p.bookmarkedByMe; }); renderAll(); }
  else if (action === "mute") { prefs.muted = [...new Set([...prefs.muted, post.posterAddress])]; savePrefs(); renderAll(); }
  else if (action === "block") {
    prefs.blocked = [...new Set([...prefs.blocked, post.posterAddress])];
    prefs.muted = prefs.muted.filter((a) => a !== post.posterAddress);
    savePrefs(); renderAll();
  }
}

// ---------------------------------------------------------------------------
// Init + events
// ---------------------------------------------------------------------------

/**
 * Tab activation. Keeps an already-loaded (and still fresh) endless-scroll window instead of
 * snapping back to page one — leaving KaPosts for a moment must not throw away everything the
 * user scrolled in. The Refresh button always reloads.
 */
/// The addresses this account follows, as KaPosts knows them locally.
///
/// Create Chat merges this with both indexer follow lists, the way iOS merges KaPostsFollowStore
/// with them: a follow made on this device is in localStorage the instant it is tapped, while the
/// indexer may not have caught up on it yet.
// ---------------------------------------------------------------------------
// Post drafts (iOS KaPostsDraftStore)
// ---------------------------------------------------------------------------

const KAPOSTS_DRAFTS_KEY = "kachat-kaposts-drafts-v1";

/// Saved drafts, newest first. Local and unsynced on purpose, exactly as on iOS: a draft is
/// unfinished writing, and putting it on chain or in a shared backup publishes something the
/// writer never decided to publish.
let kapostDrafts = [];
/// The draft currently open in the composer, so saving again updates it rather than piling up a
/// second copy of the same unfinished post.
let editingDraftId = null;

function loadDrafts() {
  try {
    const raw = JSON.parse(localStorage.getItem(deps.accountScopedKey(KAPOSTS_DRAFTS_KEY)) || "[]");
    kapostDrafts = Array.isArray(raw) ? raw : [];
  } catch {
    kapostDrafts = [];
  }
}

function saveDrafts() {
  try {
    localStorage.setItem(deps.accountScopedKey(KAPOSTS_DRAFTS_KEY), JSON.stringify(kapostDrafts));
  } catch { /* a full quota is not worth losing the composer over */ }
}

/// One line for the list: the first segment with anything in it.
function draftPreview(draft) {
  const segments = [draft?.text || "", ...(draft?.threadSegments || [])];
  return (segments.find((segment) => segment.trim()) || "").trim();
}

/// Everything this draft would post, for the "3 posts" count on its row.
function draftSegmentCount(draft) {
  return [draft?.text || "", ...(draft?.threadSegments || [])].filter((segment) => segment.trim()).length;
}

/// Saves what is in the composer, or updates the draft it was opened from. Returns the draft, or
/// null when there was nothing worth keeping.
function saveDraftFromComposer() {
  const text = String(composerInput?.value || "");
  const threadSegments = [...composerThreadSegments];
  if (![text, ...threadSegments].some((segment) => segment.trim())) return null;
  const draft = {
    id: editingDraftId || nowId(),
    text,
    threadSegments,
    quotedRemoteId: composerQuoteTarget?.remoteId || null,
    // Separate from quotedRemoteId rather than one id plus a kind, so drafts saved before replies
    // had a composer still reopen as the quotes they were.
    replyRemoteId: composerReplyTarget?.remoteId || null,
    savedAt: Date.now(),
  };
  kapostDrafts = [draft, ...kapostDrafts.filter((entry) => entry.id !== draft.id)];
  saveDrafts();
  return draft;
}

function deleteDraft(id) {
  const before = kapostDrafts.length;
  kapostDrafts = kapostDrafts.filter((entry) => entry.id !== id);
  if (kapostDrafts.length !== before) saveDrafts();
}

/// Reopens a draft in the composer. The draft stays saved until the post actually goes out -
/// losing it the moment it is opened would mean a reader who changed their mind has nothing left.
async function openDraft(id) {
  const draft = kapostDrafts.find((entry) => entry.id === id);
  if (!draft) return;
  // A draft keeps only the ID of the post it was about (never a stale copy of someone else's
  // post), so resolve it here - loaded lists first, then the indexer. Until get-post existed this
  // lookup could not be done at all, so a quote draft reopened as a plain post and lost its
  // source; the same resolution now brings a reply draft back with the post it answers.
  const sourceId = draft.replyRemoteId || draft.quotedRemoteId || null;
  let source = sourceId ? allPostLists().find((post) => post.remoteId === sourceId) || null : null;
  if (sourceId && !source) source = await indexerPost(sourceId);
  if (sourceId && !source) source = await chainPost(sourceId).catch(() => null);
  if (draft.replyRemoteId) openComposer(null, { replyTarget: source });
  else openComposer(source);
  editingDraftId = draft.id;
  composerThreadSegments = [...(draft.threadSegments || [])];
  composerInput.value = draft.text || "";
  composerInput.dispatchEvent(new Event("input", { bubbles: true }));
  // A reopened draft's composer has no Poll or Schedule (iOS draftComposer passes neither).
  renderComposerExtras();
  composerInput.focus();
}

// ---------------------------------------------------------------------------
// Scheduled posts (iOS 3b1aecf, KAPOSTS_INDEXER.md §5.10): built and signed when the author
// chose the time, submitted by the indexer at that time - or by this browser, if the indexer
// could not be reached, the next time the app runs after it. The coins a scheduled post spends
// stay reserved until it is on chain.
// ---------------------------------------------------------------------------
const SCHEDULED_KEY = "kachat-kaposts-scheduled-v1";
let scheduledPosts = [];   // { id (txId), text, notBefore, createdAt, spentOutpoints, serialized, restJson, onServer, status, error, submittedAt }
function loadScheduled() {
  try { scheduledPosts = JSON.parse(localStorage.getItem(deps.accountScopedKey(SCHEDULED_KEY)) || "[]") || []; }
  catch { scheduledPosts = []; }
  if (!Array.isArray(scheduledPosts)) scheduledPosts = [];
  publishReserved();
}
function saveScheduled() {
  scheduledPosts.sort((a, b) => a.notBefore - b.notBefore);
  try { localStorage.setItem(deps.accountScopedKey(SCHEDULED_KEY), JSON.stringify(scheduledPosts)); } catch { /* fine */ }
  publishReserved();
}
function reservedOutpoints() {
  return scheduledPosts.filter((e) => e.status === "scheduled").flatMap((e) => e.spentOutpoints || []);
}
function publishReserved() { setReservedOutpoints(reservedOutpoints()); }

async function scheduleForLater(text, notBefore) {
  let built;
  try {
    built = await buildScheduledPost({ engine: deps.engine, text, mentionedPubkeys: await mentionedPubkeysFor(text), reservedOutpoints });
  } catch (error) {
    deps.appendEngineLog?.(`KaPost schedule build failed: ${error.message}`);
    // iOS scheduleDelayedPost reports both outcomes on the KaPosts confirmation toast, with no
    // explorer link: nothing is on chain until its time comes.
    showActionToast(`Couldn't schedule: ${userFacingError(error)}`);
    restoreComposerDraft(text);
    return;
  }
  const entry = { id: built.txId, text, notBefore, createdAt: Date.now(), spentOutpoints: built.spentOutpoints, serialized: built.serialized, safeJson: built.safeJson || null, restJson: built.restJson, onServer: false, status: "scheduled", error: null, submittedAt: null };
  scheduledPosts = scheduledPosts.filter((e) => e.id !== entry.id);
  scheduledPosts.push(entry);
  saveScheduled();
  const when = new Date(notBefore).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  try {
    await scheduleOnServer({ engine: deps.engine, txId: built.txId, notBeforeMs: notBefore, restJson: built.restJson });
    entry.onServer = true;
    saveScheduled();
    showActionToast(`Scheduled for ${when}`);
  } catch (error) {
    deps.appendEngineLog?.(`Scheduling on the indexer failed, keeping it local: ${error.message}`);
    showActionToast(`Scheduled for ${when} - sends from this browser`);
  }
  renderAll();
}

/** Due entries the indexer never took go out from here; the ones it did are re-offered.
 *  One pass at a time: the 15 s first tick and the minute interval must not both submit the
 *  same transaction. A node that refuses the transaction marks it failed; a connection that
 *  is not up yet leaves it scheduled for the next pass. */
let dueInFlight = null;
const NODE_REJECTION_RE = /reject|invalid|already|orphan|missing|spent|insufficient|signature|mass|dust|not found|utxo/i;
function sendDueScheduled() {
  if (dueInFlight) return dueInFlight;
  dueInFlight = sendDueScheduledNow().finally(() => { dueInFlight = null; });
  return dueInFlight;
}
async function sendDueScheduledNow() {
  const now = Date.now();
  const list = scheduledPosts;
  let changed = false;
  for (const entry of list) {
    if (list !== scheduledPosts) return; // the account switched mid-pass
    if (entry.status !== "scheduled" || entry.onServer) continue;
    if (entry.notBefore <= now) {
      try {
        await submitScheduledLocally({ engine: deps.engine, serialized: entry.serialized, safeJson: entry.safeJson || null });
        if (list !== scheduledPosts) return;
        entry.status = "submitted";
        entry.submittedAt = Date.now();
      } catch (error) {
        if (list !== scheduledPosts) return;
        const message = error?.message || String(error);
        if (NODE_REJECTION_RE.test(message) || /cannot be rebuilt/.test(message)) {
          entry.status = "failed";
          entry.error = message;
        }
        deps.appendEngineLog?.(`Scheduled post ${entry.status === "failed" ? "failed to submit" : "submit deferred"}: ${message}`);
      }
      changed = true;
    } else {
      try { await scheduleOnServer({ engine: deps.engine, txId: entry.id, notBeforeMs: entry.notBefore, restJson: entry.restJson }); if (list !== scheduledPosts) return; entry.onServer = true; changed = true; }
      catch { /* still local */ }
    }
  }
  if (changed && list === scheduledPosts) { saveScheduled(); renderAll(); }
}

async function refreshScheduledFromServer() {
  let remote;
  try { remote = await fetchScheduledPosts({ engine: deps.engine }); } catch { return; }
  const byId = new Map(remote.map((r) => [r.txId, r]));
  let changed = false;
  for (const entry of scheduledPosts) {
    if (!entry.onServer) continue;
    const server = byId.get(entry.id);
    if (!server) continue;
    const status = ["scheduled", "submitted", "failed", "cancelled"].includes(server.status) ? server.status : entry.status;
    if (status !== entry.status || (server.error || null) !== (entry.error || null)) {
      entry.status = status;
      entry.error = server.error || null;
      entry.submittedAt = server.submittedAt ? Number(server.submittedAt) : entry.submittedAt;
      changed = true;
    }
  }
  if (changed) saveScheduled();
}

// iOS KaPostsScheduledStore.cancel / remove: straight from the row's button, no confirmation,
// and a cancel the indexer did not hear is dropped silently (`try?`).
async function cancelScheduledPost(id) {
  const entry = scheduledPosts.find((e) => e.id === id);
  if (!entry) return;
  if (entry.status === "scheduled" && entry.onServer) {
    try { await cancelScheduledOnServer({ engine: deps.engine, txId: entry.id }); }
    catch (error) { deps.appendEngineLog?.(`Scheduled post cancel on the indexer failed: ${error?.message || error}`); }
  }
  scheduledPosts = scheduledPosts.filter((e) => e.id !== id);
  saveScheduled();
  renderAll();
}

/** What the Scheduled screen does on appear and on pull-to-refresh (iOS scheduledSheet):
 *  send what is due from here first, then read the indexer's statuses. */
async function refreshScheduledPanel(panel) {
  try { await sendDueScheduled(); } catch { /* the next pass retries */ }
  await refreshScheduledFromServer();
  if (activePanel === panel) renderPanel();
}

function scheduledPanelHtml() {
  if (!scheduledPosts.length) {
    return panelEmptyHtml("clock", "No scheduled posts", "Write a post, tap Schedule in the composer and pick a time. It is signed now and goes out then.");
  }
  const fmt = (ms) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return scheduledPosts.map((entry) => {
    const when = fmt(entry.notBefore);
    // iOS scheduledIcon / scheduledLine: a status mark in the line's tint, the error on its own line.
    let meta;
    let icon;
    if (entry.status === "submitted") { meta = `Posted ${entry.submittedAt ? fmt(entry.submittedAt) : when}`; icon = "checkCircle"; }
    else if (entry.status === "failed") { meta = `Failed to post at ${when}`; icon = "alertCircle"; }
    else if (entry.status === "cancelled") { meta = "Cancelled"; icon = "xCircle"; }
    else {
      meta = entry.onServer ? `Goes out ${when}` : `Goes out ${when} - from this browser, so keep KaChat open around then`;
      icon = entry.onServer ? "clock" : "computer";
    }
    return `
      <div class="kaposts-draft-row kaposts-scheduled-row ${entry.status}">
        <div class="kaposts-draft-open">
          <span class="kaposts-draft-preview">${deps.escapeHtml(entry.text)}</span>
          <span class="kaposts-draft-meta kaposts-scheduled-line"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PANEL_ICONS[icon]}"/></svg>${deps.escapeHtml(meta)}</span>
          ${entry.status === "failed" && entry.error ? `<span class="kaposts-scheduled-error">${deps.escapeHtml(entry.error)}</span>` : ""}
        </div>
        <button class="kaposts-draft-delete" type="button" data-kaposts-cancel-scheduled="${deps.escapeHtml(entry.id)}" aria-label="${entry.status === "scheduled" ? "Cancel scheduled post" : "Remove"}" title="${entry.status === "scheduled" ? "Cancel" : "Remove"}">&times;</button>
      </div>`;
  }).join("");
}

function draftsPanelHtml() {
  if (!kapostDrafts.length) {
    return `<div class="no-results-card"><strong>No drafts</strong>`
      + `<span>Close the composer with something written and you'll be offered a draft.</span></div>`;
  }
  return kapostDrafts.map((draft) => {
    const count = draftSegmentCount(draft);
    // When it was saved, spelled out ("2 hours, 23 minutes"), as iOS's Text(savedAt, style: .relative).
    const meta = [kapostsLongRelativeTime(draft.savedAt), count > 1 ? `${count} posts` : ""].filter(Boolean).join(" · ");
    return `
      <div class="kaposts-draft-row">
        <button class="kaposts-draft-open" type="button" data-kaposts-open-draft="${deps.escapeHtml(draft.id)}">
          <span class="kaposts-draft-preview">${deps.escapeHtml(draftPreview(draft))}</span>
          <span class="kaposts-draft-meta">${deps.escapeHtml(meta)}</span>
        </button>
        <button class="kaposts-draft-delete" type="button" data-kaposts-delete-draft="${deps.escapeHtml(draft.id)}" aria-label="Delete draft">&times;</button>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Post translation (iOS PostTranslationService)
// ---------------------------------------------------------------------------

/// Per-post translation state, keyed the way iOS keys it: by post id when there is one, else by
/// the text itself so an unsent or local-only post still has somewhere to hold its result.
///
/// Values are { status, text, sourceName, reason } where status is one of "translating",
/// "translated", "failed" or "unavailable". "failed" is retryable - a dropped connection, a server
/// briefly away - and "unavailable" is terminal for this post and this reader: the pair is not
/// served, the post was too long, or it was already in their language. Saying which matters,
/// because one invites a second tap and the other makes it pointless.
const kapostTranslations = new Map();
const kapostShowingOriginal = new Set();
let kapostLanguages = null;
let kapostLanguagesUrl = "";

/// Terminal verdicts, keyed "<txid>:<target>" -> reason.
///
/// Persisted, because the alternative is what this fixes: the map above lives in memory, so every
/// reload forgot that the server had already answered "already in your language" and the offer
/// came back on a post that will never need translating. Only the short reason is stored - a
/// translated 25,000-character post has no business in localStorage.
const KAPOSTS_TRANSLATION_VERDICTS_KEY = "kachat-kaposts-translation-verdicts-v1";
const KAPOSTS_VERDICT_LIMIT = 500;
let kapostTerminalVerdicts = {};

function loadTranslationVerdicts() {
  try {
    const raw = JSON.parse(localStorage.getItem(deps.accountScopedKey(KAPOSTS_TRANSLATION_VERDICTS_KEY)) || "{}");
    kapostTerminalVerdicts = raw && typeof raw === "object" ? raw : {};
  } catch { kapostTerminalVerdicts = {}; }
}

function saveTranslationVerdicts() {
  try {
    const entries = Object.entries(kapostTerminalVerdicts);
    // Oldest out first past the cap: this only ever grows otherwise, and a reader who scrolls for
    // months should not carry every verdict they have ever collected.
    if (entries.length > KAPOSTS_VERDICT_LIMIT) {
      kapostTerminalVerdicts = Object.fromEntries(entries.slice(entries.length - KAPOSTS_VERDICT_LIMIT));
    }
    localStorage.setItem(deps.accountScopedKey(KAPOSTS_TRANSLATION_VERDICTS_KEY), JSON.stringify(kapostTerminalVerdicts));
  } catch { /* a full quota costs the memo, not the translation */ }
}

/// The post's TRANSACTION id plus the reader's language. A local session post has no txid, so its
/// verdict stays in memory - there is nothing stable to file it under.
function verdictKeyFor(post) {
  const txId = /^[0-9a-f]{64}$/i.test(String(post?.remoteId || "")) ? String(post.remoteId).toLowerCase() : null;
  return txId ? `${txId}:${readerLanguage()}` : null;
}

function rememberTerminalVerdict(post, reason) {
  const key = verdictKeyFor(post);
  if (!key) return;
  kapostTerminalVerdicts[key] = String(reason || "Translation unavailable");
  saveTranslationVerdicts();
}

function rememberedVerdict(post) {
  const key = verdictKeyFor(post);
  return key ? kapostTerminalVerdicts[key] || null : null;
}

// --- Language detection -------------------------------------------------------------------
// Offering to translate a post that is already in the reader's language is the one failure worth
// engineering against: it is wrong on every render, for every reader, on most of the feed. iOS
// asks NLLanguageRecognizer offline before offering; the browser's equivalent is the built-in
// LanguageDetector, which only recent Chromium has - so this ASKS where it can, and lets the
// server settle it (once, now remembered) where it cannot.
// iOS PostTranslationService: four letters are needed to run the recognizer at all ("gm" and
// emoji-only posts drop out). Text in a dominant non-Latin script takes the recognizer's answer
// with no confidence floor - the script has settled the question. Latin-script text keeps a
// floor that scales with length: 0.55 from twelve letters up, 0.75 below (admits "bom dia",
// rejects "hola").
const KAPOSTS_MIN_DETECT_LETTERS = 4;
const KAPOSTS_LATIN_LONG_LETTERS = 12;
const KAPOSTS_MIN_DETECT_CONFIDENCE = 0.55;
const KAPOSTS_SHORT_LATIN_CONFIDENCE = 0.75;
function dominantScriptIsLatin(text) {
  const letters = String(text || "").match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin * 2 >= letters.length;
}
function detectConfidenceFloor(text) {
  if (!dominantScriptIsLatin(text)) return 0;
  return detectableLetterCount(text) >= KAPOSTS_LATIN_LONG_LETTERS ? KAPOSTS_MIN_DETECT_CONFIDENCE : KAPOSTS_SHORT_LATIN_CONFIDENCE;
}
const KAPOSTS_DETECT_CACHE_LIMIT = 400;     // iOS detectionCache.countLimit
/// stripped text -> language code, or "" for "could not tell". Keyed by content, like iOS.
const kapostDetected = new Map();
const kapostDetecting = new Set();
let kapostDetectorPromise = null;
let kapostDetectRepaintTimer = null;

/// URLs and @mentions go first: a post that is mostly a link otherwise identifies as whatever
/// language the URL's letters resemble (iOS strippedForDetection).
function strippedForDetection(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, " ").replace(/@[A-Za-z0-9._-]+/g, " ");
}

function detectableLetterCount(text) {
  const matched = String(text || "").match(/\p{L}/gu);
  return matched ? matched.length : 0;
}

/// The browser's detector, or null where there isn't one. Created once and shared.
function ensureLanguageDetector() {
  if (kapostDetectorPromise) return kapostDetectorPromise;
  const Detector = typeof window !== "undefined" ? window.LanguageDetector : null;
  if (!Detector || typeof Detector.create !== "function") {
    kapostDetectorPromise = Promise.resolve(null);
    return kapostDetectorPromise;
  }
  kapostDetectorPromise = (async () => {
    try {
      if (typeof Detector.availability === "function") {
        const availability = await Detector.availability();
        if (availability === "downloadable" || availability === "downloading") {
          // iOS has its detector built in, and without one Translate is never offered (iOS
          // canOffer), so the browser's small detection model is fetched - which Chrome allows
          // only from a user gesture: the next click or key press starts it. Until it is ready
          // the texts read as "could not tell"; then they are detected again.
          fetchLanguageDetectorOnNextGesture(Detector);
          return null;
        }
        if (availability !== "available") return null;
      }
      return await Detector.create();
    } catch { return null; }
  })();
  return kapostDetectorPromise;
}

let kapostDetectorFetchArmed = false;
function fetchLanguageDetectorOnNextGesture(Detector) {
  if (kapostDetectorFetchArmed || typeof window === "undefined") return;
  kapostDetectorFetchArmed = true;
  const start = () => {
    window.removeEventListener("pointerdown", start, true);
    window.removeEventListener("keydown", start, true);
    Detector.create().then((detector) => {
      kapostDetectorPromise = Promise.resolve(detector);
      // Forget the "could not tell" verdicts made without it, so every text is looked at again.
      for (const [text, code] of [...kapostDetected]) if (!code) kapostDetected.delete(text);
      scheduleDetectionRepaint();
    }).catch(() => { kapostDetectorFetchArmed = false; });
  };
  window.addEventListener("pointerdown", start, true);
  window.addEventListener("keydown", start, true);
}

/// Other screens that draw translations (public chat rooms) repaint through here.
const translationListeners = new Set();
export function onTranslationChange(listener) {
  translationListeners.add(listener);
  return () => translationListeners.delete(listener);
}
function notifyTranslationListeners() {
  for (const listener of translationListeners) { try { listener(); } catch { /* a listener's fault */ } }
}
/// One repaint per burst. Detection resolves per post, and a feed of fifty would otherwise
/// re-render fifty times.
function scheduleDetectionRepaint() {
  if (kapostDetectRepaintTimer) return;
  kapostDetectRepaintTimer = setTimeout(() => {
    kapostDetectRepaintTimer = null;
    renderAll();
    notifyTranslationListeners();
  }, 60);
}

/// Fills the detection cache for a post, then schedules the repaint that reveals or withholds its
/// Translate link. Rendering is synchronous and detection is not, hence cache-first.
function detectLanguageSoon(post) {
  const stripped = strippedForDetection(post?.text);
  if (kapostDetected.has(stripped) || kapostDetecting.has(stripped)) return;
  if (detectableLetterCount(stripped) < KAPOSTS_MIN_DETECT_LETTERS) {
    kapostDetected.set(stripped, "");
    scheduleDetectionRepaint();
    return;
  }
  kapostDetecting.add(stripped);
  ensureLanguageDetector().then(async (detector) => {
    let code = "";
    if (detector) {
      try {
        const results = await detector.detect(stripped);
        const best = (Array.isArray(results) ? results : [])
          .find((row) => row?.detectedLanguage && row.detectedLanguage !== "und");
        if (best && Number(best.confidence) >= detectConfidenceFloor(stripped)) {
          code = String(best.detectedLanguage).split("-")[0].toLowerCase();
        }
      } catch { code = ""; }
    }
    // Oldest out, not everything: clearing the whole cache made the next render re-detect every
    // post on screen, whose results refilled it past the limit and cleared it again - a repaint
    // loop on a long feed.
    while (kapostDetected.size >= KAPOSTS_DETECT_CACHE_LIMIT * 4) kapostDetected.delete(kapostDetected.keys().next().value);
    kapostDetected.set(stripped, code);
    kapostDetecting.delete(stripped);
    scheduleDetectionRepaint();
  }).catch(() => {
    kapostDetecting.delete(stripped);
  });
}

function translationServiceUrl() {
  // Settings > Connection > Translation Service (iOS): its own endpoint, defaulting to the
  // KaPost indexer's box.
  return String(getEndpoint("translationService") || getEndpoint("kapostIndexer") || "").replace(/\/+$/, "");
}

/// The reader's language, as a bare code: "pt-BR" is a Portuguese reader.
function readerLanguage() {
  const raw = String(navigator.language || "en");
  return raw.split("-")[0].toLowerCase();
}

function translationKeyFor(post) {
  return post?.id || `text:${String(post?.text || "").slice(0, 120)}`;
}

/// What the service can actually translate. Cached per service URL, and a failure to answer is not
/// treated as "nothing is supported" - the link is offered anyway and the real request decides,
/// which is what iOS does. A deployment that has not built this endpoint yet should not silently
/// remove the feature.
async function ensureTranslationLanguages() {
  const base = translationServiceUrl();
  if (!base) return null;
  if (kapostLanguages && kapostLanguagesUrl === base) return kapostLanguages;
  try {
    const response = await fetch(`${base}/translate/languages`, { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const json = await response.json();
    kapostLanguages = {
      source: new Set((json?.source || []).map(String)),
      target: new Set((json?.target || []).map(String)),
    };
    kapostLanguagesUrl = base;
    return kapostLanguages;
  } catch {
    return null;
  }
}

/// Is this post worth offering to translate?
///
/// iOS asks a real language detector first and only offers when the detected language differs from
/// the reader's. A browser has no such detector it can rely on, so this deliberately asks less and
/// lets the SERVER decide: anything with enough text to detect gets the offer, and a post that
/// comes back already in the reader's language is marked unavailable so the offer disappears and
/// does not come back. One wasted request, once, per post that did not need translating - against
/// guessing with a character-frequency heuristic and being wrong about somebody's language.
function canOfferTranslation(post) {
  if (!translationServiceUrl()) return false;
  const text = String(post?.text || "").trim();
  if (text.length < 8) return false;
  const state = kapostTranslations.get(translationKeyFor(post));
  if (state?.status === "unavailable") return false;
  // A verdict this reader already collected, from any earlier session: the post was already in
  // their language, or the pair is not served. Settled questions stay settled.
  if (rememberedVerdict(post)) return false;
  // Withheld while detection is pending rather than shown-then-retracted: a link that appears and
  // vanishes is the same wrong affordance, just briefly.
  const detected = kapostDetected.get(strippedForDetection(text));
  if (detected === undefined) {
    detectLanguageSoon(post);
    return false;
  }
  return detectedLanguageIsOfferable(detected);
}

/// iOS PostTranslationService.canOffer: only a text CONFIDENTLY in another language than the
/// reader's - "could not tell" (no detector in this browser, too few letters, low confidence)
/// offers nothing - and, once the service's language list is known, only a pair it serves.
function detectedLanguageIsOfferable(detected) {
  const target = readerLanguage();
  if (!detected || detected === target) return false;
  const languages = kapostLanguages;
  if (!languages || kapostLanguagesUrl !== translationServiceUrl()) return true;
  return languages.source.has(detected) && languages.target.has(target);
}

async function translatePost(post) {
  const key = translationKeyFor(post);
  const existing = kapostTranslations.get(key);
  if (existing?.status === "translating") return;
  const base = translationServiceUrl();
  if (!base) return;

  kapostTranslations.set(key, { status: "translating" });
  kapostShowingOriginal.delete(key);
  renderAll();

  await ensureTranslationLanguages();
  const target = readerLanguage();

  try {
    // The service's id is the post's TRANSACTION id (64 hex), which is what it caches by. post.id
    // is the local render id - "remote-<txid>" for a fetched post - so sending it got every
    // translation refused with "Invalid post id. Must be 64 hex characters." A local session post
    // has no txid yet; sending no id at all is how iOS handles that, and the post is still
    // translated, just not cached for the next reader.
    const txId = /^[0-9a-f]{64}$/i.test(String(post.remoteId || "")) ? String(post.remoteId) : null;
    const body = { target, posts: [txId ? { id: txId, text: post.text } : { text: post.text }] };
    const response = await fetch(`${base}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      // Generous, because the FIRST request for a language pair can make the server load that
      // pair's model. Everyone after is answered from its cache; only the reader who asked first
      // ever waits, and a short timeout turned that one reader's wait into an error.
      signal: AbortSignal.timeout ? AbortSignal.timeout(45_000) : undefined,
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json())?.error || message; } catch {}
      // 4xx is the server saying this will never work; 5xx and the rest are worth another tap.
      const terminal = response.status >= 400 && response.status < 500;
      kapostTranslations.set(key, terminal ? { status: "unavailable", reason: message } : { status: "failed" });
      if (terminal) rememberTerminalVerdict(post, message);
      renderAll();
      return;
    }
    const entry = (await response.json())?.translations?.[0];
    if (!entry || entry.error) {
      const reason = entry?.error || "Translation unavailable";
      kapostTranslations.set(key, { status: "unavailable", reason });
      rememberTerminalVerdict(post, reason);
    } else if (entry.untranslated || !entry.text || entry.source === target) {
      // Already in the reader's language. Terminal: no amount of tapping changes it, and the
      // offer should stop appearing on this post - in this session and every later one.
      kapostTranslations.set(key, { status: "unavailable", reason: "Already in your language" });
      rememberTerminalVerdict(post, "Already in your language");
      // The server just said what the post's language is; believe it, so every other copy of this
      // text on screen stops offering too.
      if (entry.source) kapostDetected.set(strippedForDetection(post.text), String(entry.source).split("-")[0].toLowerCase());
    } else {
      kapostTranslations.set(key, {
        status: "translated",
        text: String(entry.text),
        sourceName: languageDisplayName(entry.source),
      });
    }
  } catch {
    kapostTranslations.set(key, { status: "failed" });
  }
  renderAll();
}

// --- Text translation for other screens (iOS 03e5128: public chat messages) --------------------
// The same service, detection and state maps, addressed by a caller-chosen key and bare text:
// no id is sent, so the server translates without caching (TRANSLATION_SERVICE.md). Only ever
// for text that is public already - 1:1 and group messages are encrypted and never leave the device.

/** Worth offering: enough text, confidently detected in another language than the reader's, and a
 *  pair the service serves (iOS canOffer - nothing when the language could not be told). */
export function canOfferTextTranslation(key, text) {
  if (!translationServiceUrl()) return false;
  const clean = String(text || "").trim();
  if (clean.length < 8) return false;
  const state = kapostTranslations.get(key);
  if (state?.status === "unavailable") return false;
  const detected = kapostDetected.get(strippedForDetection(clean));
  if (detected === undefined) { detectLanguageSoon({ text: clean }); return false; }
  return detectedLanguageIsOfferable(detected);
}
export function textTranslationState(key) {
  const state = kapostTranslations.get(key) || null;
  return state ? { ...state, showingOriginal: kapostShowingOriginal.has(key) } : null;
}
/** The text to draw: the translation, unless the reader asked for the original. */
export function translatedTextFor(key, original) {
  const state = kapostTranslations.get(key);
  if (state?.status !== "translated" || kapostShowingOriginal.has(key)) return original;
  return state.text;
}
export function showOriginalText(key) { kapostShowingOriginal.add(key); notifyTranslationListeners(); }
export function showTranslatedText(key) { kapostShowingOriginal.delete(key); notifyTranslationListeners(); }
/** The reader's own language by name ("English"), for "Translate into English". */
export function readerLanguageName() {
  return languageDisplayName(readerLanguage());
}
export async function translateText(key, text) {
  const existing = kapostTranslations.get(key);
  if (existing?.status === "translating") return;
  const base = translationServiceUrl();
  if (!base) return;
  kapostTranslations.set(key, { status: "translating" });
  kapostShowingOriginal.delete(key);
  notifyTranslationListeners();
  await ensureTranslationLanguages();
  const target = readerLanguage();
  try {
    const response = await fetch(`${base}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ target, posts: [{ text: String(text || "") }] }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(45_000) : undefined,
    });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try { message = (await response.json())?.error || message; } catch {}
      const terminal = response.status >= 400 && response.status < 500;
      kapostTranslations.set(key, terminal ? { status: "unavailable", reason: message } : { status: "failed" });
    } else {
      const entry = (await response.json())?.translations?.[0];
      if (!entry || entry.error) {
        kapostTranslations.set(key, { status: "unavailable", reason: entry?.error || "Translation unavailable" });
      } else if (entry.untranslated || !entry.text || entry.source === target) {
        kapostTranslations.set(key, { status: "unavailable", reason: "Already in your language" });
        if (entry.source) kapostDetected.set(strippedForDetection(String(text || "")), String(entry.source).split("-")[0].toLowerCase());
      } else {
        kapostTranslations.set(key, { status: "translated", text: String(entry.text), sourceName: languageDisplayName(entry.source) });
      }
    }
  } catch {
    kapostTranslations.set(key, { status: "failed" });
  }
  notifyTranslationListeners();
}

/// "ru" -> "Russian", in the reader's own language, falling back to the code itself.
function languageDisplayName(code) {
  const raw = String(code || "").trim();
  if (!raw) return "another language";
  try {
    const names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
    return names.of(raw) || raw;
  } catch {
    return raw;
  }
}

/// The line under a post's text: an offer, a progress note, or where the text came from.
function translateAffordanceHtml(post) {
  const key = translationKeyFor(post);
  const state = kapostTranslations.get(key);
  const id = deps.escapeHtml(String(post.id || ""));
  const link = (label) => `<button class="kaposts-translate-link" type="button" data-kaposts-translate="${id}">${deps.escapeHtml(label)}</button>`;

  if (!state) return canOfferTranslation(post) ? link("Translate post") : "";
  if (state.status === "translating") return `<span class="kaposts-translate-note with-spinner"><span class="kaposts-spinner" aria-hidden="true"></span>Translating...</span>`;
  if (state.status === "failed") return link("Translation unavailable - try again");
  if (state.status === "unavailable") return `<span class="kaposts-translate-note">${deps.escapeHtml(state.reason || "Translation unavailable")}</span>`;
  if (kapostShowingOriginal.has(key)) {
    return `<button class="kaposts-translate-link" type="button" data-kaposts-show-translation="${id}">Show translation</button>`;
  }
  return `<span class="kaposts-translate-note">Translated from ${deps.escapeHtml(state.sourceName || "another language")}`
    + ` - <button class="kaposts-translate-link" type="button" data-kaposts-show-original="${id}">Show original</button></span>`;
}

/// The text a post should render with: its translation, unless the reader asked for the original.
// (A folded cell lays out only kapostsFoldedPrefix of it - eight lines never need more than
// ~1 200 characters, and laying out a 25 000-character post to clip it was the feed's lag, iOS
// a3a7524. Unfolding shows it all.)
function postDisplayText(post) {
  const key = translationKeyFor(post);
  const state = kapostTranslations.get(key);
  if (state?.status !== "translated" || kapostShowingOriginal.has(key)) return post.text;
  return state.text;
}

export function kaPostsFollowingAddresses() {
  return [...(prefs.following || [])];
}

/// Stops the new-posts check when the tab is left, mirroring how iOS tears its check down with the
/// view. Exported so the tab switch can call it the way it already calls stopBroadcastPolling.
export function stopKaPostsPolling() {
  stopNewPostsCheck();
}

/** No KaPost indexer on this network (testnet has none yet, iOS 0bda85e): say so, rather than
 *  run feed work and polling against nothing - or against the mainnet indexer, which would serve
 *  mainnet posts under testnet addresses. */
function kapostsUnavailableHere() { return !String(getEndpoint("kapostIndexer") || "").trim(); }
function renderKaPostsUnavailable() {
  if (statusEl) statusEl.hidden = true;
  if (!feedEl) return;
  feedEl.innerHTML = `
    <div class="no-results-card kaposts-empty">
      ${/* iOS KaPostsUnavailableView's "text.bubble" */ ""}
      <svg class="kaposts-empty-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"/></svg>
      <strong>KaPosts isn't available on Testnet yet</strong>
      <span>There is no KaPost indexer for testnet. Turn off Testnet in Settings > Connection to read and post on mainnet.</span>
    </div>`;
}

export function refreshKaPostsFeed() {
  if (!deps) return;
  if (kapostsUnavailableHere()) { stopNewPostsCheck(); renderKaPostsUnavailable(); return; }
  // Opening the tab is what arms the check, and it only runs while the tab is the one on screen -
  // nothing polls a feed nobody is looking at.
  startNewPostsCheck();
  // .kachat answers that landed while the tab was away (the feed itself repaints below).
  if (posterRepaintPending && (activePanel || currentThreadPost())) repaintPosterIdentities();
  posterRepaintPending = false;
  // Coming back to the tab keeps the pages already scrolled in and the reader's place: page one
  // is re-pulled only when nothing is loaded or it is over 5 minutes old, otherwise just the
  // newer posts are looked for (iOS c18fb77).
  if (remotePosts.length > 0 && Date.now() - lastFeedLoadAt < FEED_STALE_AFTER_MS) {
    const keepTop = contentScrollTop;
    renderFeed();
    const scroller = kapostsScrollEl();
    if (scroller && keepTop && scroller.scrollTop !== keepTop) scroller.scrollTop = keepTop;
    checkForNewPosts();
    return;
  }
  loadFeed();
}

export function resetKaPostsForAccount() {
  syncRailBadge();
  loadPrefs();
  loadDrafts();
  loadScheduled();
  editingDraftId = null;
  localPosts = [];
  remotePosts = [];
  pendingNewPosts = [];
  // Another account's translations are not this one's, and the state is keyed by post id.
  kapostTranslations.clear();
  kapostShowingOriginal.clear();
  // Verdicts are stored per account, so the new one reads its own. Detection is keyed by text,
  // not by account, but the feed is about to be replaced anyway.
  loadTranslationVerdicts();
  kapostDetected.clear();
  kapostDetecting.clear();
  myContentPosts = [];
  threadStack = [];
  activePanel = null;
  panelOverThread = false;
  pendingThreadScrollRemoteId = null;
  threadHighlightRemoteId = null;
  // The one-shot on-chain follow sync is a module latch: without clearing it the SECOND
  // account of a session never rebuilt its local follow set and sat at "following 0" until
  // the app was reloaded.
  followingChainSynced = false;
  // Account change: every cursor, every in-flight page and every observer belongs to the old
  // wallet's lists.
  feedGeneration += 1;
  threadGeneration += 1;
  panelGeneration += 1;
  feedPager = makePager();
  threadPagers.clear();
  // Chains and the thread-root probe cache hold the previous wallet's posts, and both are
  // searched by findPost now — they must not survive the switch.
  threadChains.clear();
  threadRootProbe.clear();
  renderedFeedIds = new Set();
  lastFeedLoadAt = 0;
  // Nothing loaded belongs to the new identity (iOS loadGates.reset, loadedFeedSource = nil).
  loadedFeedSource = null;
  popularSweptAt = 0;
  ownContentLoadedAt = 0;
  fetchedAncestors.clear();
  clearAllPagerSentinels();
  inlinePagerKeys.clear();
  renderAll();
  renderPanel();
}

// --- @mention autocomplete --------------------------------------------------
// Attach to a composer textarea: typing "@" opens a menu of your 1:1 contacts' names - their
// .kachat names first (deps.getKachatMentionNames), then their .kas domains
// (deps.getMentionCandidates) - and a live-resolved name for the query by the mention rule:
// .kachat first, else .kas (iOS d0c5b09, e493c97). Picking one inserts "@name.ending ", so it resolves on the service shown.
const MENTION_QUERY_RE = /(?:^|[\s([{<"'])@([a-z0-9-]*)$/i;

function attachMentionAutocomplete(textarea) {
  if (!MENTIONS_ENABLED) return;
  if (!textarea || textarea.dataset.mentionWired) return;
  textarea.dataset.mentionWired = "1";
  let menu = null;
  let items = [];
  let activeIndex = 0;
  let anchorStart = -1; // index of the '@' currently being completed
  // Live resolution of the current query, .kachat first, else .kas (contacts come from the
  // local list; this row lets you mention anyone with a name anywhere).
  let resolveToken = 0;
  let resolvedExtra = null; // { query, domain } - domain with its ending, e.g. "bob.kachat"

  function close() {
    if (menu) { menu.remove(); menu = null; }
    items = [];
    activeIndex = 0;
    anchorStart = -1;
    resolveToken += 1;
    resolvedExtra = null;
  }

  function scheduleAnyKnsResolve(query) {
    const clean = String(query || "").toLowerCase();
    const token = ++resolveToken;
    if (resolvedExtra && resolvedExtra.query !== clean) resolvedExtra = null;
    if (clean.length < 2) return;
    window.setTimeout(async () => {
      if (token !== resolveToken) return;
      try {
        // anyone with a name: .kachat first, else the .kas name (the mention rule, iOS e493c97)
        const results = (await deps.engine.resolveNameEverywhere?.(clean)) || [];
        const resolution = mentionResolution(clean, results);
        if (token !== resolveToken || !resolution?.name) return;
        resolvedExtra = { query: clean, domain: String(resolution.name).toLowerCase() };
        const ctx = currentQuery();
        if (ctx && ctx.query.toLowerCase() === clean) render(ctx.query);
      } catch { /* no match: contacts-only list stands */ }
    }, 400);
  }

  function currentQuery() {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const match = before.match(MENTION_QUERY_RE);
    if (!match) return null;
    const query = match[1] || "";
    return { query, atIndex: caret - query.length - 1, caret };
  }

  function render(query) {
    const q = String(query || "").toLowerCase();
    const candidates = deps.getMentionCandidates?.() || [];
    // contacts' .kachat names come first, then their .kas domains (as "name.kas": the ending
    // typed is the service it resolves on, iOS d0c5b09)
    const kachat = [...new Set((deps.getKachatMentionNames?.() || []).map((n) => String(n).toLowerCase()))]
      .filter((full) => !q || full.startsWith(q))
      .sort()
      .map((full) => ({ domain: full, name: "" }));
    const kas = candidates
      .filter((c) => !q || c.domain.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q))
      .map((c) => ({ domain: `${c.domain.toLowerCase()}.kas`, name: c.name }));
    items = [...kachat, ...kas].slice(0, 6);
    // a live-resolved name matching the query (any service, .kachat first) rides along
    if (resolvedExtra && resolvedExtra.query === q && resolvedExtra.domain.startsWith(q)
        && !items.some((c) => c.domain.toLowerCase() === resolvedExtra.domain)) {
      items = [...items, { domain: resolvedExtra.domain, name: "" }];
    }
    if (!items.length) { close(); return; }
    if (activeIndex >= items.length) activeIndex = 0;
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "kaposts-mention-menu";
      document.body.appendChild(menu);
    }
    menu.innerHTML = items.map((c, i) => `
      <button type="button" class="kaposts-mention-option${i === activeIndex ? " active" : ""}" data-mention-index="${i}">
        <strong>@${deps.escapeHtml(c.domain)}</strong>${c.name && c.name.toLowerCase() !== c.domain.toLowerCase() ? `<span>${deps.escapeHtml(c.name)}</span>` : ""}
      </button>`).join("");
    const rect = textarea.getBoundingClientRect();
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.width = `${Math.min(rect.width, 320)}px`;
  }

  function choose(index) {
    const item = items[index];
    const caret = textarea.selectionStart ?? textarea.value.length;
    if (!item || anchorStart < 0) { close(); return; }
    const before = textarea.value.slice(0, anchorStart);
    const after = textarea.value.slice(caret);
    const insert = `@${item.domain} `;
    textarea.value = before + insert + after;
    const newCaret = before.length + insert.length;
    close();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    textarea.setSelectionRange(newCaret, newCaret);
  }

  function refresh() {
    const ctx = currentQuery();
    if (!ctx) { close(); return; }
    anchorStart = ctx.atIndex;
    render(ctx.query);
    scheduleAnyKnsResolve(ctx.query);
  }

  textarea.addEventListener("input", refresh);
  textarea.addEventListener("keydown", (event) => {
    if (!menu || !items.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); activeIndex = (activeIndex + 1) % items.length; render(currentQuery()?.query || ""); }
    else if (event.key === "ArrowUp") { event.preventDefault(); activeIndex = (activeIndex - 1 + items.length) % items.length; render(currentQuery()?.query || ""); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); choose(activeIndex); }
    else if (event.key === "Escape") { event.preventDefault(); close(); }
  });
  textarea.addEventListener("blur", () => { window.setTimeout(close, 150); });
  document.addEventListener("mousedown", (event) => {
    if (!menu) return;
    const opt = event.target.closest?.("[data-mention-index]");
    if (opt) { event.preventDefault(); choose(Number(opt.dataset.mentionIndex)); return; }
    if (!menu.contains(event.target) && event.target !== textarea) close();
  });
}

export function initKaPosts(dependencies) {
  deps = dependencies;
  startKaPostsNotificationPolling();
  // .kachat names, avatars, banners and bios land on their own (iOS 3d6fb7c), on every network.
  if (!initKaPosts.identityWired) {
    initKaPosts.identityWired = true;
    document.addEventListener("error", handlePosterImageError, true);
    if (kachatNamesUiEnabled()) onKachatIdentityChange(() => schedulePosterRepaint());
  }

  feedEl = document.querySelector("[data-kaposts-feed]");
  const contentScroller = kapostsScrollEl();
  if (contentScroller && !contentScroller.dataset.scrollTracked) {
    contentScroller.dataset.scrollTracked = "1";
    contentScroller.addEventListener("scroll", () => {
      if (contentScroller.clientHeight > 0) contentScrollTop = contentScroller.scrollTop;
    }, { passive: true });
  }
  statusEl = document.querySelector("[data-kaposts-status]");
  tabsEl = document.querySelector("[data-kaposts-feed-tabs]");
  threadEl = document.querySelector("[data-kaposts-thread]");
  threadRootEl = document.querySelector("[data-kaposts-thread-root]");
  threadRepliesEl = document.querySelector("[data-kaposts-thread-replies]");
  toastsEl = document.querySelector("[data-kaposts-toasts]");
  composerEl = document.querySelector("[data-kaposts-composer]");
  composerInput = document.querySelector("[data-kaposts-composer-input]");
  composerMeter = document.querySelector("[data-kaposts-composer-meter]");
  composerSubmit = document.querySelector("[data-kaposts-composer-submit]");
  composerTitle = document.querySelector("[data-kaposts-composer-title]");
  composerQuote = document.querySelector("[data-kaposts-composer-quote]");
  replyInput = document.querySelector("[data-kaposts-reply-input]");
  replyMeter = document.querySelector("[data-kaposts-reply-meter]");
  replySend = document.querySelector("[data-kaposts-reply-send]");
  attachMentionAutocomplete(replyInput);
  attachMentionAutocomplete(composerInput);
  panelEl = document.querySelector("[data-kaposts-panel]");
  panelTitleEl = document.querySelector("[data-kaposts-panel-title]");
  panelBodyEl = document.querySelector("[data-kaposts-panel-body]");
  popoverEl = document.querySelector("[data-kaposts-popover]");

  loadPrefs();
  loadDrafts();
  loadScheduled();
  // Due scheduled posts the indexer never took go out from here: at start and every minute.
  window.setTimeout(() => { sendDueScheduled().catch(() => {}); }, 15_000);
  window.setInterval(() => { if (!document.hidden) sendDueScheduled().catch(() => {}); }, 60_000);
  loadTranslationVerdicts();

  // Feed tab switching
  tabsEl?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kaposts-feed-tab]");
    if (!button) return;
    const tab = button.dataset.kapostsFeedTab;
    // Re-selecting the tab on screen changes nothing (iOS onChange(of: selectedFeed)).
    if (tab === activeFeedTab) return;
    activeFeedTab = tab;
    tabsEl.querySelectorAll("[data-kaposts-feed-tab]").forEach((b) => b.classList.toggle("active", b === button));
    // Feed <-> Popular share the global feed: keep every page already scrolled in (Popular is a
    // re-sort of the same set) and only deepen Popular's window. Only a real source change - to
    // or from Following - starts a new paginated feed.
    if (feedSourceFor(tab) === loadedFeedSource && remotePosts.length > 0) {
      renderFeed({ resetScroll: true });
      if (tab === "popular") deepenPopularRanking();
      return;
    }
    // Retire the outgoing tab's cursor before anything can repaint: its sentinel must not
    // fire a "load more" that would page the tab the user just left.
    feedPager = null;
    clearPagerSentinel("feed");
    renderFeed();
    loadFeed().then(() => { if (activeFeedTab === "popular") deepenPopularRanking(); });
  });

  document.querySelector("[data-kaposts-refresh]")?.addEventListener("click", () => loadFeed());
  feedEl?.addEventListener("click", (event) => {
    if (!event.target.closest("[data-kaposts-load-older]")) return;
    if (feedPager) { feedPager.stalled = false; feedPager.unproductive = 0; feedPager.error = null; }
    loadMoreFeed();
  });
  // The create-post button is where the zero-balance gate lives (iOS createPostButton): with a
  // confirmed-zero chatting balance it shows the funding card (QR + address + copy) instead of a
  // composer that could never submit.
  document.querySelector("[data-kaposts-compose]")?.addEventListener("click", () => {
    if (deps.isChattingBalanceZero?.()) { deps.showFundingGate?.(); return; }
    openComposer();
  });
  // X-style persistent rail: the sections are always visible on the left.
  document.querySelectorAll("[data-kaposts-rail]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.kapostsRail;
      // KaPosts Settings, the last rail item as on iOS: its own window over whatever is open.
      if (key === "settings") { deps.openKaPostsSettings?.(); return; }
      threadStack = [];
      threadGeneration += 1; // drops any reply page still in flight for the thread we left
      // The rail always leaves the thread, so nothing here is an over-thread panel.
      panelOverThread = false;
      pendingThreadScrollRemoteId = null;
      if (key === "feed") closePanel();
      else if (key === "search") openSearchPanel();
      else if (key === "notifications") openNotificationsPanel();
      else if (key === "profile") openPosterProfile(deps.engine.address, safeRequesterPubkey());
      else {
        rememberFeedScroll();
        panelGeneration += 1;
        clearPanelPagerSentinels();
        activePanel = beginPanel({ type: "list", kind: key });
        renderPanel();
      }
      renderThread();
      renderFeed();
      syncRailActive();
    });
  });
  panelBodyEl?.addEventListener("input", (event) => {
    if (!event.target.matches("[data-kaposts-search-input]") || activePanel?.type !== "search") return;
    activePanel.query = event.target.value;
    renderSearchResults(activePanel);
  });
  panelBodyEl?.addEventListener("click", (event) => {
    const panel = activePanel;
    if (panel?.type !== "search") return;
    const scope = event.target.closest("[data-kaposts-search-scope]");
    if (scope) { panel.scope = scope.dataset.kapostsSearchScope; renderSearchResults(panel); return; }
    if (event.target.closest("[data-kaposts-search-more]")) { loadMoreSearch(); return; }
    const postRow = event.target.closest("[data-kaposts-search-post]");
    if (postRow) {
      // A TXID rather than the post itself: resolved through the same path a shared link
      // takes, which knows how to find a post that is not in the loaded feed.
      resolveAndOpenPost(postRow.dataset.kapostsSearchPost);
      return;
    }
    const personRow = event.target.closest("[data-kaposts-search-person]");
    if (personRow) openPosterProfile(personRow.dataset.kapostsSearchPerson, personRow.dataset.kapostsSearchPubkey || null);
  });
  document.querySelector("[data-kaposts-panel-back]")?.addEventListener("click", () => {
    // A follow list opened from a profile returns to that profile; everything else closes to the feed.
    if (activePanel?.type === "followList" && activePanel.parent?.address) {
      openPosterProfile(activePanel.parent.address, activePanel.parent.pubkey || null);
      return;
    }
    // A Post Activity kind's list returns to the count cards, its loaded rows kept.
    if (activePanel?.type === "engagement" && activePanel.tab) {
      activePanel.tab = null;
      if (panelBodyEl) panelBodyEl.scrollTop = 0;
      renderPanel();
      return;
    }
    closePanel();
    syncRailActive();
  });
  document.addEventListener("click", (event) => {
    if (!popoverEl || popoverEl.hidden) return;
    if (!popoverEl.contains(event.target) && !event.target.closest("[data-kaposts-more], [data-kaposts-repost], [data-kaposts-link], [data-kaposts-notification]")) {
      closePopover();
    }
  });
  document.querySelector("[data-kaposts-composer-cancel]")?.addEventListener("click", () => { closeComposer(); });
  document.querySelector("[data-kaposts-thread-back]")?.addEventListener("click", () => {
    threadStack.pop();
    // Leaving the thread retires any unspent reply-landing scroll target.
    pendingThreadScrollRemoteId = null;
    threadHighlightRemoteId = null;
    if (threadStack.length === 0) {
      // Back at the feed: drop every thread cursor so a re-open starts from a fresh page one.
      threadGeneration += 1;
      threadPagers.clear();
      clearPagerSentinel("thread");
    }
    renderThread();
    // Thread was opened from a profile/bookmarks panel: return to THAT panel, not the feed.
    if (threadStack.length === 0 && activePanel) {
      renderPanel();
      return;
    }
    renderFeed();
    restoreFeedScroll();
  });

  composerInput?.addEventListener("input", () => {
    updateMeter(composerInput, composerMeter, composerSubmit);
    // Runs AFTER updateMeter: the meter disables Post on empty input, but with stacked
    // thread segments "Post All (n)" must stay enabled - the thread UI has the final say.
    renderComposerThreadUi();
  });
  // The formatting toolbar (iOS MarkdownFormattingToolbar). Every button toggles, and every one
  // writes the same markers a person could have typed by hand, so the two ways of formatting a
  // post produce identical text. mousedown is swallowed so the click never steals focus from the
  // textarea: the selection it acts on has to still be there when the click lands.
  const mdToolbar = document.querySelector("[data-kaposts-md-toolbar]");
  mdToolbar?.addEventListener("mousedown", (event) => { if (event.target.closest("button")) event.preventDefault(); });
  mdToolbar?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kaposts-md]");
    if (!button || !composerInput) return;
    applyComposerFormatting(button.dataset.kapostsMd);
  });
  // The desktop shortcuts people already have in their fingers; iOS has no hardware keys here.
  composerInput?.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    const action = { b: "bold", i: "italic", u: "underline" }[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    applyComposerFormatting(action);
  });
  composerSubmit?.addEventListener("click", () => {
    const text = composerInput.value.trim();
    const segments = text ? [...composerThreadSegments, text] : [...composerThreadSegments];
    if (!segments.length) return;
    const quoteTarget = composerQuoteTarget;
    const replyTarget = composerReplyTarget;
    const editTarget = composerEditTarget;
    // The post is on its way, so the draft it came from has served its purpose. Explicit
    // keepDraft: false, because closeComposer would otherwise ask whether to keep writing that
    // is already being sent.
    const extras = composerExtrasAllowed();
    const poll = extras ? composerPoll : null;
    const scheduleAt = extras ? composerScheduleAt : null;
    // A poll posts with its question and its valid options only - the empty ones are left out,
    // and the button stays off until there are two to four (iOS postAll / pollIsValid).
    if (poll && (!text || !pollEditorValid())) return;
    const pollOptions = poll ? validPollOptions() : null;
    if (editingDraftId) deleteDraft(editingDraftId);
    closeComposer({ keepDraft: false });
    if (poll && !editTarget && !replyTarget && !quoteTarget && segments.length === 1) { schedulePoll(segments[0], pollOptions, poll.lengthMs); return; }
    if (scheduleAt != null && !editTarget && !replyTarget && !quoteTarget && segments.length === 1) { scheduleForLater(segments[0], scheduleAt); return; }
    if (editTarget) scheduleEdit(editTarget, segments[0]);
    else if (replyTarget) submitReply(replyTarget, segments[0]);
    else if (quoteTarget) scheduleQuote(quoteTarget, segments[0]);
    else if (segments.length > 1) scheduleThread(segments);
    else schedulePost(segments[0]);
  });

  // Poll and Schedule chips and their editors.
  // Poll toggles (iOS: pollEnabled.toggle(); turning it on clears a scheduled time).
  document.querySelector("[data-kaposts-poll-toggle]")?.addEventListener("click", () => {
    if (composerPoll) {
      composerPoll = null;
      renderComposerExtras();
      return;
    }
    composerPoll = { options: ["", ""], lengthMs: 86400000 };
    composerScheduleAt = null;
    renderComposerExtras();
    document.querySelector("[data-kaposts-poll-option='0']")?.focus();
  });
  document.querySelector("[data-kaposts-poll-add]")?.addEventListener("click", () => {
    if (!composerPoll || composerPoll.options.length >= KAPOSTS_POLL_MAX_OPTIONS) return;
    composerPoll.options.push("");
    renderComposerExtras();
    document.querySelector(`[data-kaposts-poll-option='${composerPoll.options.length - 1}']`)?.focus();
  });
  // XP-007 (iOS 7842c18): an option is cut to 40 Unicode scalars at a character boundary - the
  // indexer's unit. No `maxlength`: it counts UTF-16 units, which would stop an emoji option short
  // (and could split a pair). Not while an IME is composing; compositionend re-runs it.
  const syncPollOption = (event) => {
    const option = event.target.closest("[data-kaposts-poll-option]");
    if (!option || !composerPoll) return;
    if (!event.isComposing && pollOptionLength(option.value) > KAPOSTS_POLL_OPTION_MAX_LENGTH) {
      option.value = prefixPollOption(option.value, KAPOSTS_POLL_OPTION_MAX_LENGTH);
    }
    composerPoll.options[Number(option.dataset.kapostsPollOption)] = option.value;
    renderComposerThreadUi(); // Post Poll turns on once the options are valid
  };
  document.querySelector("[data-kaposts-poll-editor]")?.addEventListener("input", syncPollOption);
  document.querySelector("[data-kaposts-poll-editor]")?.addEventListener("compositionend", syncPollOption);
  document.querySelector("[data-kaposts-poll-editor]")?.addEventListener("change", (event) => {
    if (event.target.matches("[data-kaposts-poll-length]") && composerPoll) composerPoll.lengthMs = Number(event.target.value) || 86400000;
  });
  document.querySelector("[data-kaposts-poll-editor]")?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-kaposts-poll-option-remove]");
    if (!remove || !composerPoll) return;
    composerPoll.options.splice(Number(remove.dataset.kapostsPollOptionRemove), 1);
    renderComposerExtras();
  });
  // Schedule / Reschedule opens the picker sheet; its button sets the time ("Schedule for
  // <date>"), and the row under the composer clears it (iOS extrasRow + scheduleRow).
  document.querySelector("[data-kaposts-schedule-toggle]")?.addEventListener("click", () => {
    if (composerPoll) return;
    openScheduleSheet();
  });
  const scheduleSheet = scheduleSheetEl();
  scheduleSheet?.querySelector("[data-kaposts-schedule-input]")?.addEventListener("input", syncScheduleSheetButton);
  scheduleSheet?.querySelector("[data-kaposts-schedule-input]")?.addEventListener("change", syncScheduleSheetButton);
  scheduleSheet?.querySelector("[data-kaposts-schedule-confirm]")?.addEventListener("click", () => {
    const pick = scheduleSheetPick();
    if (pick == null) return;
    composerScheduleAt = pick;
    composerPoll = null;
    closeScheduleSheet();
    renderComposerExtras();
    composerInput?.focus();
  });
  // Dismissed like a sheet: a click outside it, or Escape.
  scheduleSheet?.addEventListener("click", (event) => { if (event.target === scheduleSheet) closeScheduleSheet(); });
  scheduleSheet?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); closeScheduleSheet(); }
  });
  document.querySelector("[data-kaposts-schedule-remove]")?.addEventListener("click", () => { composerScheduleAt = null; renderComposerExtras(); });

  // X-style +: stack the current text as a thread segment and keep writing.
  composerThreadAddEl()?.addEventListener("click", () => {
    const text = composerInput.value.trim();
    if (!text || composerQuoteTarget) return;
    composerThreadSegments.push(text);
    composerInput.value = "";
    updateMeter(composerInput, composerMeter, composerSubmit);
    // A thread has no Poll or Schedule (iOS extrasAvailable), so the chips go with the first segment.
    renderComposerExtras();
    composerInput.focus();
  });
  composerSegmentsEl()?.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-kaposts-thread-remove]");
    if (!remove) return;
    composerThreadSegments.splice(Number(remove.dataset.kapostsThreadRemove), 1);
    renderComposerExtras();
  });

  // The reply box pinned under the open thread (iOS postDetailSheet). Replying to a specific
  // reply still opens the composer - see the data-kaposts-reply-to handler.
  replyInput?.addEventListener("input", () => { updateMeter(replyInput, replyMeter); autoGrowReply(); });
  // The zero-balance gate: a reply costs KAS, so with a confirmed 0 balance the bar greys and
  // a click on it presents the funding card instead of the keyboard. Reading is untouched.
  const replyBar = replyInput?.closest(".kaposts-reply-bar");
  replyBar?.addEventListener("click", (event) => {
    if (!replyBar.classList.contains("gated")) return;
    event.preventDefault();
    replyInput.blur();
    deps.showFundingGate?.();
  }, true);
  replySend?.addEventListener("click", () => {
    if (deps.isChattingBalanceZero?.()) {
      deps.showFundingGate?.();
      return;
    }
    const text = replyInput.value.trim();
    const topId = threadStack[threadStack.length - 1];
    const target = topId ? findPost(topId) : null;
    if (!text || !target || !target.remoteId) return;
    replyInput.value = "";
    updateMeter(replyInput, replyMeter);
    autoGrowReply(); // a sent reply leaves the box grown to its old size otherwise
    submitReply(target, text);
  });

  // Delegated feed/thread/toast interactions
  const screen = document.querySelector('[data-app-tab-screen="kaposts"]');
  screen?.addEventListener("click", (event) => {
    const vote = event.target.closest("[data-kaposts-poll-vote]");
    if (vote) {
      event.stopPropagation();
      const post = findPost(vote.dataset.kapostsPollVote);
      if (post) scheduleVote(post, Number(vote.dataset.index));
      return;
    }
    const link = event.target.closest("[data-kaposts-link]");
    if (link) {
      event.stopPropagation();
      // iOS LinkActionsSheet: the link itself gets room to be read, because deciding whether
      // to open a link IS reading it.
      const href = link.dataset.kapostsLink;
      openPopover(link, `
        <div class="kaposts-pop-url">${deps.escapeHtml(href)}</div>
        <button type="button" class="kaposts-pop-row" data-kaposts-link-open="${deps.escapeHtml(href)}"><strong>Open Link</strong><small>Opens in your browser.</small></button>
        <button type="button" class="kaposts-pop-row" data-kaposts-link-copy="${deps.escapeHtml(href)}"><strong>Copy Link</strong><small>Copies the address to your clipboard.</small></button>`);
      // Scrolling locks while the link menu is up - click away (or pick an option) to release.
      setKaPostsScrollLock(true);
      return;
    }
    const linkOpen = event.target.closest("[data-kaposts-link-open]");
    if (linkOpen) {
      closePopover();
      // KaChat links open in the app; everything else only if it is web (iOS 5090ad9).
      const href = String(linkOpen.dataset.kapostsLinkOpen || "");
      if (deps.openKaChatLink?.(href)) return;
      if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
      return;
    }
    const linkCopy = event.target.closest("[data-kaposts-link-copy]");
    if (linkCopy) {
      closePopover();
      navigator.clipboard?.writeText(linkCopy.dataset.kapostsLinkCopy);
      deps.showToast?.("Link copied");
      return;
    }

    const replyTo = event.target.closest("[data-kaposts-reply-to]");
    if (replyTo) {
      // Replying opens the composer for THAT post - the root, or any comment in the thread -
      // with the post being answered rendered below the editor. This replaces the bar plus its
      // "Replying to" chip, where the thing you were answering was off screen while you typed.
      const target = findPost(replyTo.dataset.kapostsReplyTo);
      if (target) openComposer(null, { replyTarget: target });
      return;
    }

    const pagerRetry = event.target.closest("[data-kaposts-pager-retry]");
    if (pagerRetry) { retryPager(pagerRetry.dataset.kapostsPagerRetry); return; }

    const undo = event.target.closest("[data-kaposts-undo]");
    if (undo) { cancelUndoable(undo.dataset.kapostsUndo); return; }

    const countdown = event.target.closest("[data-kaposts-countdown]");
    if (countdown) { cancelUndoable(countdown.dataset.kapostsCountdown); return; }
    // The undo capsule a held like / dislike / repost shows in place of its button.
    const cancelPending = event.target.closest("[data-kaposts-cancel-pending]");
    if (cancelPending) { cancelUndoable(cancelPending.dataset.kapostsCancelPending); return; }

    const like = event.target.closest("[data-kaposts-like]");
    if (like) { const p = findPost(like.dataset.kapostsLike); if (p) toggleVote(p, "like"); return; }

    const dislike = event.target.closest("[data-kaposts-dislike]");
    if (dislike) { const p = findPost(dislike.dataset.kapostsDislike); if (p) toggleVote(p, "dislike"); return; }

    const repost = event.target.closest("[data-kaposts-repost]");
    if (repost) {
      const p = findPost(repost.dataset.kapostsRepost);
      if (!p || !p.remoteId || !p.posterPubkey) return;
      openRepostPopover(repost, p);
      return;
    }

    const pop = event.target.closest("[data-kaposts-pop]");
    if (pop) {
      handlePopoverAction(pop.dataset.kapostsPop, findPost(pop.dataset.kapostsPopId));
      return;
    }

    if (event.target.closest("[data-kaposts-settings]")) { deps.openKaPostsSettings?.(); return; }
    const more = event.target.closest("[data-kaposts-more]");
    if (more) {
      const p = findPost(more.dataset.kapostsMore);
      if (p) openMorePopover(more, p);
      return;
    }

    const profileTap = event.target.closest("[data-kaposts-profile]");
    if (profileTap) {
      const p = findPost(profileTap.dataset.kapostsProfile);
      // Already looking at this person's profile: re-opening it rebuilt the panel and threw the
      // reader back to the top of it, which is what tapping a row in your own profile did.
      if (p && !(activePanel?.type === "profile" && activePanel.address === p.posterAddress)) {
        openPosterProfile(p.posterAddress, p.posterPubkey);
      }
      return;
    }

    const profileTab = event.target.closest("[data-kaposts-profile-tab]");
    if (profileTab && activePanel?.type === "profile") {
      activePanel.tab = profileTab.dataset.kapostsProfileTab;
      renderPanel();
      return;
    }

    const profileFollow = event.target.closest("[data-kaposts-profile-follow]");
    const profileChat = event.target.closest("[data-kaposts-profile-chat]");
    if (profileChat && activePanel?.type === "profile") {
      deps.startChat?.(activePanel.address, posterName(activePanel.address));
      return;
    }
    if (event.target.closest("[data-kaposts-edit-kns]")) { deps.editKnsProfile?.(); return; }
    if (event.target.closest("[data-kaposts-bio-more]") && activePanel?.type === "profile") {
      const bio = posterProfilePieces(activePanel.address).bio || "";
      deps.alertDialog?.({ title: "Bio", message: bio, confirmLabel: "Done" });
      return;
    }
    if (profileFollow && activePanel?.type === "profile") {
      toggleFollow({ posterAddress: activePanel.address, posterPubkey: activePanel.pubkey });
      renderPanel();
      return;
    }

    const followListCount = event.target.closest("[data-kaposts-follow-list]");
    if (followListCount && activePanel?.type === "profile") {
      openFollowListPanel({
        address: activePanel.address,
        pubkey: activePanel.pubkey,
        mode: followListCount.dataset.kapostsFollowList,
        parent: { address: activePanel.address, pubkey: activePanel.pubkey },
      });
      return;
    }

    const followListFollow = event.target.closest("[data-kaposts-follow-list-follow]");
    if (followListFollow) {
      // Follow/unfollow straight from the row without opening the profile behind it.
      toggleFollow({ posterAddress: followListFollow.dataset.address, posterPubkey: followListFollow.dataset.pubkey || null });
      renderPanel();
      return;
    }

    const engagementTab = event.target.closest("[data-kaposts-engagement-tab]");
    if (engagementTab && activePanel?.type === "engagement") {
      activePanel.tab = engagementTab.dataset.kapostsEngagementTab;
      if (panelBodyEl) panelBodyEl.scrollTop = 0; // a fresh screen opens at its top
      renderPanel();
      return;
    }

    const unhide = event.target.closest("[data-kaposts-unhide]");
    if (unhide) {
      const address = unhide.dataset.kapostsUnhide;
      if (unhide.dataset.kapostsUnhideKind === "muted") prefs.muted = prefs.muted.filter((a) => a !== address);
      else prefs.blocked = prefs.blocked.filter((a) => a !== address);
      savePrefs();
      renderPanel();
      renderFeed();
      return;
    }

    const follow = event.target.closest("[data-kaposts-follow]");
    if (follow) { const p = findPost(follow.dataset.kapostsFollow); if (p) toggleFollow(p); return; }
    const bell = event.target.closest("[data-kaposts-bell]");
    if (bell) { const p = findPost(bell.dataset.kapostsBell); if (p) toggleBell(p); return; }
    const tippers = event.target.closest("[data-kaposts-tippers]");
    if (tippers) { const p = findPost(tippers.dataset.kapostsTippers); if (p?.remoteId) openTippersPanel(p); return; }

    const mentionTap = event.target.closest("[data-kaposts-mention]");
    if (mentionTap) {
      // the post's signed mentions ride along, so the tap opens who the author meant (iOS e493c97)
      const cellId = mentionTap.closest("[data-kaposts-post]")?.dataset.kapostsPost;
      const signed = (cellId && findPost(cellId)?.mentionedPubkeys) || [];
      openMentionProfile(mentionTap.dataset.kapostsMention, signed);
      return;
    }

    const cancelScheduled = event.target.closest("[data-kaposts-cancel-scheduled]");
    if (cancelScheduled) {
      cancelScheduledPost(cancelScheduled.dataset.kapostsCancelScheduled);
      return;
    }
    const openDraftBtn = event.target.closest("[data-kaposts-open-draft]");
    if (openDraftBtn) {
      openDraft(openDraftBtn.dataset.kapostsOpenDraft);
      return;
    }
    const deleteDraftBtn = event.target.closest("[data-kaposts-delete-draft]");
    if (deleteDraftBtn) {
      deleteDraft(deleteDraftBtn.dataset.kapostsDeleteDraft);
      renderAll();
      return;
    }

    if (event.target.closest("[data-kaposts-show-new]")) {
      showPendingNewPosts();
      return;
    }

    const translate = event.target.closest("[data-kaposts-translate]");
    if (translate) {
      const p = findPost(translate.dataset.kapostsTranslate);
      if (p) translatePost(p);
      return;
    }
    const showOriginal = event.target.closest("[data-kaposts-show-original]");
    if (showOriginal) {
      const p = findPost(showOriginal.dataset.kapostsShowOriginal);
      if (p) { kapostShowingOriginal.add(translationKeyFor(p)); renderAll(); }
      return;
    }
    const showTranslation = event.target.closest("[data-kaposts-show-translation]");
    if (showTranslation) {
      const p = findPost(showTranslation.dataset.kapostsShowTranslation);
      if (p) { kapostShowingOriginal.delete(translationKeyFor(p)); renderAll(); }
      return;
    }

    const tip = event.target.closest("[data-kaposts-tip]");
    if (tip) {
      const p = findPost(tip.dataset.kapostsTip);
      // The tip names the post it is for, so the post counts it (iOS a6bd60a, KAPOSTS_INDEXER.md 5.11).
      const target = p?.remoteId && p?.posterPubkey ? { postId: p.remoteId, authorPubkey: p.posterPubkey } : null;
      // A tip sent counts on its post at once; the indexer's count takes over on the next refresh (iOS 0f241ce).
      const countTip = target ? () => { mutatePost(p.id, (post) => { post.tips = (Number(post.tips) || 0) + 1; }); renderAll(); } : null;
      if (p) deps.tipUser?.(p.posterAddress, posterName(p.posterAddress), target, countTip);
      return;
    }

    const bookmark = event.target.closest("[data-kaposts-bookmark]");
    if (bookmark) {
      const p = findPost(bookmark.dataset.kapostsBookmark);
      if (p) {
        // The filled bookmark is the whole confirmation (iOS toggleBookmark): no toast.
        mutatePost(p.id, (target) => { target.bookmarkedByMe = !target.bookmarkedByMe; });
        renderAll();
      }
      return;
    }

    const share = event.target.closest("[data-kaposts-share]");
    if (share) {
      const p = findPost(share.dataset.kapostsShare);
      if (p?.remoteId) {
        navigator.clipboard?.writeText(postShareLink(p.remoteId));
        deps.showToast?.("Link copied");
      }
      return;
    }

    const retry = event.target.closest("[data-kaposts-retry]");
    if (retry) { const p = findPost(retry.dataset.kapostsRetry); if (p) retryPost(p); return; }
    const retryReplies = event.target.closest("[data-kaposts-retry-replies]");
    if (retryReplies) {
      const comment = findPost(retryReplies.dataset.kapostsRetryReplies);
      if (comment) loadCommentReplies(comment);
      return;
    }

    const notificationRow = event.target.closest("[data-kaposts-notification]");
    if (notificationRow && activePanel?.type === "notifications") {
      const item = (activePanel.items || []).find((row) => String(row.id) === notificationRow.dataset.kapostsNotification);
      if (!item) return;
      // One tap, two possible destinations - a menu that names both, headed by who did it, so
      // "open the post" and "open the transaction" never compete for the same row. View in
      // Explorer only when there is a transaction URL to open (iOS: `if let url = txURL(for:)`).
      const explorerUrl = txIdOrNull(item.id) && deps.explorerTxUrl ? deps.explorerTxUrl(item.id) : "";
      openPopover(notificationRow, `
        <div class="kaposts-pop-title">${deps.escapeHtml(posterName(item.actorAddress))}</div>
        ${item.targetTxId ? `<button type="button" class="kaposts-pop-row" data-kaposts-notif-open="${deps.escapeHtml(item.targetTxId)}" data-kaposts-notif-parent="${deps.escapeHtml(item.parentTxId || "")}"><strong>Open in KaPosts</strong><small>Goes to the post this is about, in the app.</small></button>` : ""}
        ${explorerUrl ? `<button type="button" class="kaposts-pop-row" data-kaposts-notif-explorer="${deps.escapeHtml(explorerUrl)}"><strong>View in Explorer</strong><small>Opens the transaction on your chosen block explorer.</small></button>` : ""}`);
      event.stopPropagation();
      return;
    }
    const notifOpen = event.target.closest("[data-kaposts-notif-open]");
    if (notifOpen) {
      closePopover();
      resolveAndOpenPost(notifOpen.dataset.kapostsNotifOpen, { parentRemoteIdHint: notifOpen.dataset.kapostsNotifParent || null });
      return;
    }
    const notifExplorer = event.target.closest("[data-kaposts-notif-explorer]");
    if (notifExplorer) {
      closePopover();
      window.open(notifExplorer.dataset.kapostsNotifExplorer, "_blank", "noopener");
      return;
    }

    const openRemote = event.target.closest("[data-kaposts-open-remote]");
    if (openRemote) {
      if (event.target.closest("a")) return; // let the explorer link win its own clicks
      // Reply rows carry the conversation they belong to, so the parent's thread opens even
      // when the reply's own indexer mapping has no parent id.
      resolveAndOpenPost(openRemote.dataset.kapostsOpenRemote, {
        parentRemoteIdHint: openRemote.dataset.kapostsOpenRemoteParent || null,
      });
      return;
    }

    const expand = event.target.closest("[data-kaposts-expand]");
    if (expand) {
      const id = expand.dataset.kapostsExpand;
      if (expandedPostIds.has(id)) expandedPostIds.delete(id);
      else expandedPostIds.add(id);
      renderAll();
      return;
    }

    const expandReplies = event.target.closest("[data-kaposts-expand-replies]");
    if (expandReplies) {
      const id = expandReplies.dataset.kapostsExpandReplies;
      if (expandedCommentIds.has(id)) {
        expandedCommentIds.delete(id);
        renderThread();
      } else {
        expandedCommentIds.add(id);
        const comment = findPost(id);
        if (comment) loadCommentReplies(comment);
        else renderThread();
      }
      return;
    }

    const open = event.target.closest("[data-kaposts-open]");
    if (open) {
      const post = findPost(open.dataset.kapostsOpen);
      // An ancestor you already walked down through is a level of THIS stack: unwind to it
      // rather than pushing a copy, so Back afterwards goes where it went before (iOS
      // jumpToAncestor). A rung resolved from the loaded tree, never navigated to, starts a
      // fresh stack there.
      if (post && open.closest("[data-kaposts-ancestor]")) {
        pendingThreadScrollRemoteId = null;
        const index = threadStack.indexOf(post.id);
        threadStack = index >= 0 ? threadStack.slice(0, index) : [];
        openThread(post);
        return;
      }
      if (post) {
        // Close the panel FIRST: its rows live in activePanel, and a thread rendering over a
        // still-open profile left the profile on screen - which read as the tap doing nothing
        // but scrolling the profile back to the top.
        closePanel();
        openThread(post);
      } else {
        // The local id belongs to a list this lookup does not search (a profile's own rows once
        // its panel has closed). The txid on the cell always resolves.
        const remoteId = open.closest("[data-kaposts-remote-id]")?.dataset.kapostsRemoteId;
        if (remoteId) resolveAndOpenPost(remoteId);
      }
      return;
    }
  });
}
