// Nextcloud Talk (spreed) REST client for KaChat calls: conversations, call join/leave, and the
// *internal* signaling channel (long-poll pull + POST send). Port of the iOS
// NextcloudTalkClient. One instance per call, bound to one server, in one of two modes:
//
// - the CALLER's own account (Basic app-password auth), which creates the public conversation
//   the call lives in;
// - a GUEST on the other person's server, which is how the callee joins without a Nextcloud
//   account of their own. Talk's guest sessions live in the PHP session cookie, so every request
//   carries a jar id and the same-origin relay (vite.config.mjs) keeps that server's cookies for
//   this client's life, thrown away with it.
//
// Only the internal signaling mode is spoken here (the one every Talk install has). A server
// that runs the external High-Performance Backend reports signalingMode "external", and the
// call service refuses the call with a clear message rather than half working.

export class TalkError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TalkError";
    this.code = code; // "http" | "malformed" | "sessionLost" | "conversationGone" | "external"
  }
}

const FLAG_IN_CALL = 1;
const FLAG_WITH_AUDIO = 2;
const FLAG_WITH_VIDEO = 4;

function appBase() {
  try { return import.meta.env.BASE_URL || "/"; } catch { return "/"; }
}

function randomId(length = 24) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export class NextcloudTalkClient {
  /** @param {{server: string, auth: {kind: "basic", username: string, appPassword: string} | {kind: "guest"}}} options */
  constructor({ server, auth }) {
    this.server = String(server || "").replace(/\/+$/, "");
    this.auth = auth;
    this.jarId = randomId();
    this.pullController = null;
  }

  // MARK: - Conversations

  /** Creates a public conversation (type 3) the callee can join as a guest. Returns its token. */
  async createPublicConversation(name) {
    const data = await this.ocs("POST", "/ocs/v2.php/apps/spreed/api/v4/room", { form: { roomType: "3", roomName: String(name || "KaChat call").slice(0, 255) } });
    const token = String(data?.token || "");
    if (!token) throw new TalkError("malformed", "Unexpected answer from Nextcloud Talk (no room token).");
    return token;
  }

  /** Joins the conversation as an active participant. Returns this participant's Talk session
   *  id, which is also what the internal signaling identifies us by. */
  async joinConversation(token) {
    const data = await this.ocs("POST", `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants/active`, { form: { force: "true" } });
    const sessionId = String(data?.sessionId || "");
    if (!sessionId) throw new TalkError("malformed", "Unexpected answer from Nextcloud Talk (no session id).");
    return sessionId;
  }

  async leaveConversation(token) {
    try { await this.ocs("DELETE", `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants/active`); } catch { /* best effort */ }
  }

  /** Owner only. Public conversations created for a call are throwaway. */
  async deleteConversation(token) {
    try { await this.ocs("DELETE", `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}`); } catch { /* best effort */ }
  }

  /** Guests have no account name; this is what the caller's Talk shows for them. */
  async setGuestDisplayName(token, name) {
    try { await this.ocs("POST", `/ocs/v2.php/apps/spreed/api/v1/guest/${encodeURIComponent(token)}/name`, { form: { displayName: String(name || "KaChat").slice(0, 64) } }); } catch { /* best effort */ }
  }

  // MARK: - Calls

  async joinCall(token, video) {
    const flags = FLAG_IN_CALL | FLAG_WITH_AUDIO | (video ? FLAG_WITH_VIDEO : 0);
    await this.ocs("POST", `/ocs/v2.php/apps/spreed/api/v4/call/${encodeURIComponent(token)}`, { form: { flags: String(flags), silent: "true" } });
  }

  async updateCallFlags(token, video) {
    const flags = FLAG_IN_CALL | FLAG_WITH_AUDIO | (video ? FLAG_WITH_VIDEO : 0);
    try { await this.ocs("PUT", `/ocs/v2.php/apps/spreed/api/v4/call/${encodeURIComponent(token)}`, { form: { flags: String(flags) } }); } catch { /* best effort */ }
  }

  async leaveCall(token) {
    try { await this.ocs("DELETE", `/ocs/v2.php/apps/spreed/api/v4/call/${encodeURIComponent(token)}`); } catch { /* best effort */ }
  }

  // MARK: - Signaling

  /** STUN/TURN and the signaling mode ("internal" is the one spoken here). */
  async signalingSettings(token) {
    const data = await this.ocs("GET", "/ocs/v2.php/apps/spreed/api/v3/signaling/settings", { query: { token } });
    const mode = String(data?.signalingMode || "internal");
    const iceServers = [];
    for (const entry of Array.isArray(data?.stunservers) ? data.stunservers : []) {
      const urls = Array.isArray(entry?.urls) ? entry.urls : (entry?.url ? [entry.url] : []);
      if (urls.length) iceServers.push({ urls });
    }
    for (const entry of Array.isArray(data?.turnservers) ? data.turnservers : []) {
      const urls = Array.isArray(entry?.urls) ? entry.urls : (entry?.url ? [entry.url] : []);
      if (urls.length) iceServers.push({ urls, username: entry.username || undefined, credential: entry.credential || undefined });
    }
    return { mode, iceServers };
  }

  /** One long-poll of the internal signaling channel. Resolves with the events the server had
   *  (peer messages and/or a participant list) or, when its ~30s window lapses, the list alone.
   *  404/403 mean the conversation or our session is gone; 409 means the server replaced our
   *  session (joined again elsewhere). */
  async pullSignaling(token) {
    this.cancelPull();
    const controller = new AbortController();
    this.pullController = controller;
    let response;
    try {
      response = await this.request("GET", `/ocs/v2.php/apps/spreed/api/v3/signaling/${encodeURIComponent(token)}`, { longPoll: true, signal: controller.signal });
    } finally {
      if (this.pullController === controller) this.pullController = null;
    }
    if (response.status === 404 || response.status === 403) throw new TalkError("conversationGone", "The call conversation no longer exists.");
    if (response.status === 409) throw new TalkError("sessionLost", "This device's call session was replaced on the server.");
    if (!response.ok) throw new TalkError("http", `Nextcloud Talk answered ${response.status}.`);
    const list = ocsData(await response.json().catch(() => null));
    if (!Array.isArray(list)) throw new TalkError("malformed", "Unexpected answer from Nextcloud Talk (signaling pull).");
    const events = [];
    for (const item of list) {
      if (item?.type === "usersInRoom") {
        const users = (Array.isArray(item.data) ? item.data : []).map((user) => ({
          sessionId: String(user?.sessionId || ""),
          userId: String(user?.userId || ""),
          inCall: Number(user?.inCall) || 0,
          lastPing: Number(user?.lastPing) || 0,
        }));
        events.push({ kind: "usersInRoom", users });
      } else if (item?.type === "message") {
        let payload = null;
        if (typeof item.data === "string") { try { payload = JSON.parse(item.data); } catch { payload = null; } }
        else if (item.data && typeof item.data === "object") payload = item.data;
        if (payload) events.push({ kind: "message", data: payload });
      }
    }
    return events;
  }

  /** Cancels the in-flight long poll, if any, so pullSignaling rejects at once. */
  cancelPull() {
    const controller = this.pullController;
    this.pullController = null;
    if (controller) { try { controller.abort(); } catch { /* already done */ } }
  }

  /** Peer messages on their way out; mirrors the Talk web client's Peer.send envelope. */
  async sendSignaling(token, sessionId, messages) {
    const envelopes = messages.map((message) => ({
      ev: "message",
      fn: JSON.stringify({ to: message.to, sid: message.sid, roomType: message.roomType || "video", type: message.type, payload: message.payload || {}, from: sessionId }),
      sessionId,
    }));
    await this.ocs("POST", `/ocs/v2.php/apps/spreed/api/v3/signaling/${encodeURIComponent(token)}`, { form: { messages: JSON.stringify(envelopes) } });
  }

  // MARK: - Plumbing

  async ocs(method, path, { query = null, form = null } = {}) {
    const response = await this.request(method, path, { query, form });
    if (!response.ok) {
      let message = "";
      try { message = String((await response.json())?.ocs?.meta?.message || ""); } catch { message = ""; }
      throw new TalkError("http", message ? `Nextcloud Talk answered ${response.status}: ${message.slice(0, 200)}` : `Nextcloud Talk answered ${response.status}.`);
    }
    const text = await response.text();
    if (!text) return {};
    let root = null;
    try { root = JSON.parse(text); } catch { root = null; }
    const data = ocsData(root);
    return data && typeof data === "object" ? data : {};
  }

  async request(method, path, { query = null, form = null, longPoll = false, signal = undefined } = {}) {
    const params = new URLSearchParams({ format: "json", ...(query || {}) });
    const url = `${appBase()}nc-proxy/${encodeURIComponent(this.server)}${path}?${params.toString()}`;
    const headers = {
      "OCS-APIRequest": "true",
      Accept: "application/json",
      "x-proxy-jar": this.jarId,
    };
    if (longPoll) headers["x-proxy-long-poll"] = "1";
    if (this.auth?.kind === "basic") headers.Authorization = "Basic " + btoa(`${this.auth.username}:${this.auth.appPassword}`);
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
      body = new URLSearchParams(form).toString();
    }
    const nativeFetch = window.__kasiaNativeFetch || window.fetch.bind(window);
    return nativeFetch(url, { method, headers, body, cache: "no-store", signal });
  }
}

function ocsData(root) {
  return root && typeof root === "object" && root.ocs && "data" in root.ocs ? root.ocs.data : null;
}
