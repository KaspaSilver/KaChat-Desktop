// .kachat names: a profile's avatar, banner and bio, looked up on the device.
//
// Port of iOS KachatSocialImageResolver (KaChat/Services/KachatNames/KachatNamesRegistry.swift).
// A profile record names a social profile link per piece (registry-state.js Profile /
// SocialSource); this turns such a link into what that platform shows right now - avatar, banner,
// bio - and caches the answer on this device. No indexer is involved and nothing is uploaded.
//
// - An answer is fresh for 24 hours; a stale one is still shown while it is looked up again.
// - When the platform answers but no longer shows something (taken down, account gone), it is
//   dropped at once, so the platform's moderation carries over. When the platform can't be
//   reached, the last answer stays.
// - A lookup never takes longer than 10 s (every request and fallback included), and no request
//   longer than 8 s. An answer under five minutes old is reused, so the three fields of one account
//   cost one request; lookups of the same link in flight are shared.
//
// Where each piece comes from:
//   X        FxTwitter's user API (avatar 400 px, banner, bio), X's page as the fallback
//   YouTube  the channel page: og:image, og:description, the banner from its embedded data
//   Discord  the invite API (server icon, banner, description)
//   GitHub   the public user API (avatar, bio)
//   Telegram, Kick, Twitch   the page's og:image and og:description (Twitch's boilerplate cut)
//   Instagram, TikTok, Facebook, LinkedIn   the page's og:image only (their descriptions are
//            follower counts or site text, never the person's bio)
//
// Shared with the browser-extension repo, which copies engine/kachat-names/*: every I/O
// dependency is injected, there are no app imports, and nothing runs at import.
//
// DEPENDENCY CONTRACT (constructor `deps`):
//
//   fetchText(url, options) -> Promise<{ status: number, contentType: string, text: string } | null>
//     A GET of `url`. Answer with whatever status the server gave (404 matters: "account gone");
//     null only when nothing came back (network error, timeout, refused, no relay).
//     options:
//       accept     the Accept header to send ("application/json" or "text/html,...")
//       timeoutMs  give up after this long (8000); the resolver also stops waiting on its own
//       agent      "crawler" (a link-preview crawler User-Agent, e.g. facebookexternalhit/1.1:
//                  pages emit their Open Graph tags to it) or "browser" (a desktop browser
//                  User-Agent: YouTube's channel page carries the banner in plain form; GitHub's
//                  API wants a User-Agent). A hint: honor it where the platform lets you choose.
//       maxBytes   read at most this many bytes of the body (3 MB for pages, 512 KB for JSON) and
//                  drop the rest; `text` must never be longer than this
//       signal     an AbortSignal, aborted when the lookup's 10 s deadline passes
//     It must not send the user's cookies or credentials.
//   fetchJSON(url, options) -> Promise<{ status: number, json: any|null } | null>     (optional)
//     As fetchText, for a JSON API; `json` null when the body isn't JSON. Derived from fetchText
//     when not given.
//   storage: { get(key) -> string|null, set(key, string), remove?(key) }               (optional)
//     sync or async. The 24 h cache: one entry per profile link under
//     "kachat-social-image-v1:<link>" (`{"profile":{"avatar","banner","bio"},"checkedAt":ms}`) and
//     an index under "kachat-social-image-v1:index"; at most 500 entries, the oldest dropped
//     (`remove`, or `set(key, "")` without it). Without storage the cache lives in memory only.
//   now() -> number   unix ms (default Date.now)                                        (optional)
//   log(...args)      (default: silent)                                                 (optional)
//
// API:
//   new KachatSocialImageResolver(deps)
//   resolver.resolve(sourceOrLink, { maxAgeMs = 300000 }) -> Promise<SocialLookup>
//     Looks the profile up now (the editor's review), sharing a lookup in flight; an answer younger
//     than maxAgeMs is the answer. SocialLookup:
//       { kind: "answered", profile: SocialProfile }   the platform answered (possibly empty)
//       { kind: "unreachable", profile: SocialProfile|null }   not reached in time; the last
//                                                      answer this device had, if any
//   resolver.profile(link) -> Promise<SocialProfile|null>
//     The cached answer for a link (fresh or stale), starting a lookup in the background when
//     there is none or it is stale (Swift `profile(for:)`); onChange tells when it lands.
//   resolver.cached(link) -> Promise<SocialProfile|null>   the cached answer only, no lookup
//   resolver.onChange(listener(link, SocialProfile)) -> unsubscribe()
//     Called whenever a lookup stores a new answer.
//   resolver.forget(link)   drops the cached answer for one link

import { SocialSource, SocialProfile, SocialKind } from "./registry-state.js";

/** Storage key prefix of the cache. */
export const socialImageCachePrefix = "kachat-social-image-v1:";
const indexKey = `${socialImageCachePrefix}index`;

/** An answer is fresh this long (24 h). */
export const socialFreshForMs = 24 * 3600 * 1000;
/** Hard limit for one lookup, every request and fallback included. */
export const socialLookupDeadlineMs = 10_000;
/** No request outlives this. */
export const socialRequestTimeoutMs = 8_000;
/** `resolve` reuses an answer younger than this (five minutes). */
export const socialRecentMs = 300_000;

const maxEntries = 500;
const pageMaxBytes = 3_000_000;
const jsonMaxBytes = 512_000;
const htmlAccept = "text/html,application/xhtml+xml";
const jsonAccept = "application/json";

/** A stored or fetched URL a screen may load: `https://` and nothing odd in it. */
function httpsUrl(v) {
  if (typeof v !== "string" || v.length > 2048 || !/^https:\/\/[^\s"'<>\\]+$/i.test(v)) return null;
  try { return new URL(v).protocol === "https:" ? v : null; } catch { return null; }
}

/** A SocialProfile whose pictures are https URLs and whose bio is cut to 280 characters. */
function cleanProfile(p) {
  return new SocialProfile({
    avatar: httpsUrl(p?.avatar),
    banner: httpsUrl(p?.banner),
    bio: SocialSource.trimmedBio(p?.bio),
  });
}

function sourceOf(sourceOrLink) {
  if (sourceOrLink instanceof SocialSource) return SocialSource.fromLink(sourceOrLink.link, SocialKind.avatar);
  if (typeof sourceOrLink === "string") return SocialSource.fromLink(sourceOrLink, SocialKind.avatar);
  if (sourceOrLink && typeof sourceOrLink.link === "string") return SocialSource.fromLink(sourceOrLink.link, SocialKind.avatar);
  return null;
}

export class KachatSocialImageResolver {
  constructor(deps = {}) {
    if (typeof deps.fetchText !== "function" && typeof deps.fetchJSON !== "function") {
      throw new TypeError("KachatSocialImageResolver needs fetchText");
    }
    this.deps = {
      fetchText: deps.fetchText ?? null,
      fetchJSON: deps.fetchJSON ?? null,
      storage: deps.storage ?? null,
      now: deps.now ?? (() => Date.now()),
      log: deps.log ?? (() => {}),
    };
    /** link -> { profile: SocialProfile, checkedAt: number } (loaded from storage on first use) */
    this._entries = new Map();
    /** link -> Promise of its stored entry (read once) */
    this._loading = new Map();
    /** link -> Promise<SocialLookup> */
    this._inFlight = new Map();
    this._listeners = new Set();
    this._index = null;
  }

  _now() { return Number(this.deps.now()); }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit(link, profile) {
    for (const l of [...this._listeners]) { try { l(link, profile); } catch { /* a listener's own problem */ } }
  }

  // MARK: Cache

  async _storageGet(key) {
    const st = this.deps.storage;
    if (!st) return null;
    try { return await st.get(key); } catch { return null; }
  }

  async _storageSet(key, value) {
    const st = this.deps.storage;
    if (!st) return;
    try { await st.set(key, value); } catch { /* storage full or blocked: memory only */ }
  }

  async _storageRemove(key) {
    const st = this.deps.storage;
    if (!st) return;
    try {
      if (typeof st.remove === "function") await st.remove(key);
      else await st.set(key, "");
    } catch { /* fine */ }
  }

  async _entry(link) {
    if (this._entries.has(link)) return this._entries.get(link);
    let loading = this._loading.get(link);
    if (!loading) {
      loading = this._readEntry(link);
      this._loading.set(link, loading);
    }
    const read = await loading;
    if (read && !this._entries.has(link)) this._entries.set(link, read);
    return this._entries.get(link) ?? null;
  }

  async _readEntry(link) {
    const text = await this._storageGet(socialImageCachePrefix + link);
    if (typeof text !== "string" || !text || text.length > 16_384) return null;
    try {
      const j = JSON.parse(text);
      const checkedAt = Number(j?.checkedAt);
      if (!Number.isFinite(checkedAt) || j?.profile == null || typeof j.profile !== "object") return null;
      return { profile: cleanProfile(j.profile), checkedAt };
    } catch {
      return null;
    }
  }

  /** Forget what memory holds for `link`; storage is not read for it again. */
  _drop(link) {
    this._entries.delete(link);
    this._loading.set(link, Promise.resolve(null));
  }

  async _loadIndex() {
    if (this._index) return this._index;
    let list = [];
    const text = await this._storageGet(indexKey);
    if (typeof text === "string" && text) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j)) list = j.filter((e) => Array.isArray(e) && typeof e[0] === "string" && Number.isFinite(Number(e[1])));
      } catch { list = []; }
    }
    this._index = new Map(list.map(([k, at]) => [k, Number(at)]));
    return this._index;
  }

  async _persist(link, entry) {
    await this._storageSet(socialImageCachePrefix + link, JSON.stringify({ profile: entry.profile.toJSON(), checkedAt: entry.checkedAt }));
    const index = await this._loadIndex();
    index.delete(link);
    index.set(link, entry.checkedAt);
    if (index.size > maxEntries) {
      const oldest = [...index.entries()].sort((a, b) => a[1] - b[1]).slice(0, index.size - maxEntries);
      for (const [k] of oldest) {
        index.delete(k);
        this._drop(k);
        await this._storageRemove(socialImageCachePrefix + k);
      }
    }
    await this._storageSet(indexKey, JSON.stringify([...index.entries()]));
  }

  /** The cached answer for `link` (any age), no lookup. */
  async cached(link) {
    const source = sourceOf(link);
    if (!source) return null;
    return (await this._entry(source.link))?.profile ?? null;
  }

  /** Drops the cached answer for one link. */
  async forget(link) {
    const source = sourceOf(link);
    if (!source) return;
    this._drop(source.link);
    const index = await this._loadIndex();
    if (index.delete(source.link)) await this._storageSet(indexKey, JSON.stringify([...index.entries()]));
    await this._storageRemove(socialImageCachePrefix + source.link);
  }

  /** The cached profile for `link` (fresh or stale), starting a lookup in the background when
   *  there is none or it is stale. `onChange` reports the lookup's answer. */
  async profile(link) {
    const source = sourceOf(link);
    if (!source) return null;
    const entry = await this._entry(source.link);
    if (!entry || this._now() - entry.checkedAt > socialFreshForMs) {
      this.resolve(source, { maxAgeMs: socialFreshForMs }).catch(() => {});
    }
    return entry?.profile ?? null;
  }

  // MARK: Lookups

  /** Looks the profile up now, sharing a lookup in flight. An answer younger than `maxAgeMs` is
   *  the answer. Never throws. */
  async resolve(sourceOrLink, { maxAgeMs = socialRecentMs } = {}) {
    const source = sourceOf(sourceOrLink);
    if (!source) return { kind: "answered", profile: new SocialProfile() };
    const key = source.link;
    const entry = await this._entry(key);
    if (entry && this._now() - entry.checkedAt < maxAgeMs) return { kind: "answered", profile: entry.profile };
    const running = this._inFlight.get(key);
    if (running) return running;
    const task = (async () => {
      const started = this._now();
      let outcome = null;
      try { outcome = await this._withDeadline((signal) => this._lookUp(source, signal)); } catch { outcome = null; }
      try { this.deps.log(`[KachatSocial] ${source.platform} ${outcome == null ? "unreachable" : "answered"} in ${((this._now() - started) / 1000).toFixed(1)}s`); } catch { /* fine */ }
      if (outcome == null) return { kind: "unreachable", profile: (await this._entry(key))?.profile ?? null }; // keep the last answer
      const answered = cleanProfile(outcome);
      const fresh = { profile: answered, checkedAt: this._now() };
      this._entries.set(key, fresh);
      await this._persist(key, fresh);
      this._emit(key, answered);
      return { kind: "answered", profile: answered };
    })();
    this._inFlight.set(key, task);
    try { return await task; } finally { if (this._inFlight.get(key) === task) this._inFlight.delete(key); }
  }

  /** `work`'s result, or null once the deadline passes (its signal is aborted). */
  async _withDeadline(work) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => { try { controller?.abort(); } catch { /* fine */ } resolve(null); }, socialLookupDeadlineMs);
    });
    try {
      return (await Promise.race([work(controller?.signal ?? null), timeout])) ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One request: the dependency's answer, or null on error or after 8 s. */
  async _request(fn, url, options) {
    if (typeof fn !== "function") return null;
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), socialRequestTimeoutMs); });
    try {
      const answer = await Promise.race([Promise.resolve().then(() => fn(url, { ...options, timeoutMs: socialRequestTimeoutMs })), timeout]);
      return answer ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async _text(url, { agent, signal, maxBytes = pageMaxBytes }) {
    const r = await this._request(this.deps.fetchText, url, { accept: htmlAccept, agent, maxBytes, signal });
    if (!r || !Number.isInteger(r.status)) return null;
    const text = typeof r.text === "string" ? r.text.slice(0, maxBytes) : "";
    return { status: r.status, contentType: String(r.contentType ?? ""), text };
  }

  async _json(url, { agent = "browser", signal } = {}) {
    if (typeof this.deps.fetchJSON === "function") {
      const r = await this._request(this.deps.fetchJSON, url, { accept: jsonAccept, agent, maxBytes: jsonMaxBytes, signal });
      if (!r || !Number.isInteger(r.status)) return null;
      return { status: r.status, json: r.json ?? null };
    }
    const r = await this._request(this.deps.fetchText, url, { accept: jsonAccept, agent, maxBytes: jsonMaxBytes, signal });
    if (!r || !Number.isInteger(r.status)) return null;
    let json = null;
    const text = typeof r.text === "string" ? r.text.slice(0, jsonMaxBytes) : "";
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json };
  }

  /** The platform's answer (possibly empty: taken down, account gone), or null when it couldn't
   *  be reached or answered with an error - nothing is known then. */
  async _lookUp(source, signal) {
    const S = SocialSource;
    const handle = encodeURIComponent(source.handle).replace(/%40/g, "@");
    switch (source.platform) {
      case "discord": {
        const r = await this._json(`https://discord.com/api/v10/invites/${handle}`, { signal });
        if (!r) return null;
        if (r.status === 404) return new SocialProfile();
        if (r.status !== 200 || r.json == null) return null;
        return new SocialProfile({
          avatar: S.discordImage(r.json, SocialKind.avatar),
          banner: S.discordImage(r.json, SocialKind.banner),
          bio: S.discordDescription(r.json),
        });
      }
      case "x": {
        // FxTwitter first: one small JSON answer with avatar, banner and bio. X's own page
        // (served to link-preview crawlers) is the fallback.
        const r = await this._json(`https://api.fxtwitter.com/${handle}`, { signal });
        if (r && (r.status === 200 || r.status === 404) && r.json != null) {
          const p = S.fxTwitterProfile(r.json);
          if (p) return p;
        }
        break;
      }
      case "github": {
        const r = await this._json(`https://api.github.com/users/${handle}`, { signal });
        if (!r) return null;
        if (r.status === 404) return new SocialProfile();
        if (r.status !== 200 || r.json == null) return null;
        const gh = S.githubProfile(r.json);
        return new SocialProfile({ avatar: gh.avatar, banner: null, bio: gh.bio });
      }
      default:
        break;
    }
    const page = await this._text(source.link, { agent: "crawler", signal });
    if (!page) return null;
    if (page.status === 404 || page.status === 410) return new SocialProfile();
    if (page.status !== 200) return null;
    const result = new SocialProfile();
    const image = S.openGraphImage(page.text);
    if (image) result.avatar = source.platform === "x" ? S.xAvatar(image) : image;
    result.bio = S.bio(source.platform, S.openGraphDescription(page.text));
    if (source.platform === "x") {
      result.banner = S.xBanner(page.text);
    } else if (source.platform === "youtube") {
      // The page served to the crawler usually carries the banner too; the desktop page is the
      // fallback (iOS asks it directly).
      result.banner = S.youtubeBanner(page.text);
      if (!result.banner) {
        const desktop = await this._text(source.link, { agent: "browser", signal });
        if (desktop && desktop.status === 200) result.banner = S.youtubeBanner(desktop.text);
      }
    }
    return result;
  }
}
