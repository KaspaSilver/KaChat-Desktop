// KaChat Web Push: what a push payload becomes on screen. Loaded by public/sw.js with
// importScripts (a classic script, so it defines one global, KaChatPushMap) and by
// tools/test-web-push.mjs in a sandbox. No I/O here: the worker reads the mirror from IndexedDB
// and hands it in.
//
// The payload is the JSON object docs/WEB_PUSH_SERVER.md §5 defines: the push service's FCM data
// map (string values), never message text - 1:1 and group messages are end-to-end encrypted and
// the keys stay in the app's locked vault, so the worker shows what iOS's notification extension
// falls back to when it cannot decrypt: who (from the app's mirrored address -> name map) and
// what kind ("New message", "Sent you 1.5 KAS").
//
// `mirror` (written by ui/web-push.js, names and flags only):
//   { account, unit, sound, childMode, names: {addr: name}, quiet: [addr], blocked: [addr],
//     groups: {blindedIdHex: {g: groupId, n: groupName, m: memberAddress}}, addressLabels: {addr: label} }
(function (root) {
  "use strict";

  function lower(value) { return String(value || "").trim().toLowerCase(); }
  function shortAddress(address) {
    const text = String(address || "");
    const colon = text.indexOf(":");
    const body = colon >= 0 ? text.slice(colon + 1) : text;
    if (body.length <= 14) return text;
    return `${text.slice(0, colon + 1)}${body.slice(0, 6)}...${body.slice(-6)}`;
  }
  function prefixOf(address) { const text = lower(address); const colon = text.indexOf(":"); return colon > 0 ? text.slice(0, colon) : ""; }
  // "1.5" from sompi, trailing zeros trimmed (iOS NotificationService.handlePayment).
  function kasFromSompi(value) {
    let sompi;
    try { sompi = BigInt(String(value || "0").trim()); } catch { return null; }
    if (sompi <= 0n) return null;
    const whole = sompi / 100000000n;
    const fraction = (sompi % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : String(whole);
  }
  function nameFor(mirror, address) {
    const names = (mirror && mirror.names) || {};
    return String(names[lower(address)] || "").trim() || shortAddress(address);
  }
  function has(list, address) { return Array.isArray(list) && list.indexOf(lower(address)) >= 0; }
  // A public room's or K body can be a JSON envelope (a reply, a reaction): the text inside, never
  // raw JSON on a lock screen (iOS publicChatPreviewText).
  function tidy(text, fallback) {
    const raw = String(text || "").trim();
    if (!raw) return fallback;
    if (raw[0] === "{") {
      try {
        const parsed = JSON.parse(raw);
        const inner = parsed && (parsed.text || parsed.message || parsed.content || parsed.body);
        return typeof inner === "string" && inner.trim() ? inner.trim().slice(0, 240) : fallback;
      } catch { return fallback; }
    }
    if (raw.length > 200 && !/\s/.test(raw)) return fallback; // base64 / hex blob
    return raw.slice(0, 240);
  }
  function joined(a, b, sep) { return a && b ? `${a}${sep}${b}` : (a || b || ""); }

  /**
   * payload -> { title, options, badge: "increment" | number | null, suppress }.
   * `suppress` = iOS would show nothing (your own message, a blocked sender, the other network):
   * the worker still has to show something (Safari revokes a subscription whose pushes show
   * nothing) and closes it straight away.
   */
  function notificationFromPush(payload, mirror, opts) {
    const p = payload && typeof payload === "object" ? payload : {};
    const m = mirror && typeof mirror === "object" ? mirror : {};
    const o = opts || {};
    const type = String(p.type || "");
    const unit = m.unit || "KAS";
    const account = lower(m.account);
    const sender = lower(p.sender);
    const soundOn = m.sound !== false;
    const unreadHint = Number.isFinite(Number(p.unread)) && String(p.unread).trim() !== "" ? Math.max(0, Math.floor(Number(p.unread))) : null;
    const out = {
      title: "KaChat",
      options: { body: "", tag: "kachat-push", icon: o.icon || undefined, badge: o.badgeIcon || undefined, silent: !soundOn, renotify: false, data: { route: { kind: "tab", tab: "chats" }, key: String(p.tx_id || p.dedup || ""), push: true } },
      badge: null,
      suppress: false,
    };
    const otherNetwork = (address) => Boolean(account && address && prefixOf(address) && prefixOf(address) !== prefixOf(account));

    if (type === "contextual" || type === "payment" || type === "handshake" || type === "audio") {
      if (!sender || sender === account || otherNetwork(sender) || has(m.blocked, sender)) out.suppress = true;
      // A message from someone you haven't accepted: one "New message request" per sender (a tag
      // per sender, so a second message replaces rather than adds). Payments ring as payments.
      if (p.inbox === "true" && type !== "payment") {
        out.title = "New message request";
        out.options.body = `${shortAddress(p.sender)} wants to chat with you.`;
        out.options.tag = `kachat-request-${sender}`;
        out.options.data.route = { kind: "requests" };
        return out;
      }
      out.title = nameFor(m, p.sender);
      if (type === "payment") {
        const kas = kasFromSompi(p.amount);
        out.options.body = kas ? `Sent you ${kas} ${unit}` : "Sent you a payment";
      } else if (type === "handshake") out.options.body = "Started a conversation";
      else if (type === "audio") out.options.body = "Voice message";
      else out.options.body = "New message";
      out.options.tag = `kachat-chat-${sender}`;
      out.options.renotify = true;
      out.options.silent = !soundOn || has(m.quiet, sender);
      out.options.data.route = { kind: "chatAddress", address: sender };
      out.badge = out.suppress ? null : (unreadHint ?? "increment");
      return out;
    }

    if (type === "group_message" || type === "group_control") {
      const group = (m.groups || {})[lower(p.blinded_group_id)] || null;
      if (sender && (sender === account || otherNetwork(sender))) out.suppress = true;
      const control = type === "group_control";
      if (group) {
        out.title = String(group.n || "").trim() || "Group";
        const who = nameFor(m, group.m || p.sender);
        out.options.body = control ? "Group update" : `${who}: New message`;
        out.options.tag = `kachat-group-${group.g}`;
        out.options.data.route = { kind: "group", groupId: group.g };
      } else {
        // A blinded id the app hasn't mirrored (a group joined on another device): iOS's fallback.
        out.title = "Group chat";
        out.options.body = control ? "Group update" : "New group message";
        out.options.tag = "kachat-group";
        out.options.data.route = { kind: "tab", tab: "chats" };
      }
      out.options.renotify = !control;
      if (!control && !out.suppress) out.badge = unreadHint ?? "increment";
      return out;
    }

    if (type === "broadcast") {
      const channel = lower(p.channel);
      if (m.childMode) out.suppress = true;
      out.title = String(p.title || "").trim() || `#${channel}`;
      out.options.body = joined(String(p.subtitle || "").trim(), tidy(p.body, "New message"), ": ");
      out.options.tag = `kachat-broadcast-${p.tx_id || channel}`;
      out.options.data.route = { kind: "room", channel };
      return out;
    }

    if (type === "kaposts") {
      if (m.childMode) out.suppress = true;
      out.title = "KaPosts";
      out.options.body = joined(String(p.subtitle || "").trim(), tidy(p.body, ""), " ") || "New activity";
      out.options.tag = `kachat-kaposts-${p.tx_id || p.post_id || "activity"}`;
      out.options.data.route = p.post_id ? { kind: "kapost", txId: String(p.post_id) } : { kind: "tab", tab: "kaposts" };
      return out;
    }

    if (type === "name_event") {
      out.title = String(p.title || "").trim() || ".kachat";
      out.options.body = String(p.body || "").trim();
      out.options.tag = `kachat-name-${String(p.dedup || p.tx_id || p.name || "event").slice(0, 64)}`;
      out.options.data.route = { kind: "tab", tab: "kachat-names", name: String(p.name || "") };
      return out;
    }

    if (type === "address_activity") {
      const address = String(p.address || "").trim();
      const kas = String(p.amount_kas || "").trim() || kasFromSompi(p.amount_sompi);
      out.title = kas ? `Received ${kas} ${unit}` : "Funds received";
      out.options.body = String(((m.addressLabels || {})[lower(address)]) || "").trim() || shortAddress(address);
      out.options.tag = `kachat-addr-activity-${p.tx_id || address}`;
      out.options.data.route = { kind: "address", address };
      return out;
    }

    // A type this build doesn't know yet: the server's own wording.
    out.title = String(p.title || "").trim() || "KaChat";
    out.options.body = String(p.body || "").trim() || "Something new in KaChat";
    out.options.tag = `kachat-push-${p.tx_id || type || "other"}`;
    return out;
  }

  /** The route a focused screen is showing, in the same terms a push's route uses, so the worker
   *  can tell "this is the chat you are looking at" (iOS willPresent's active-conversation rule). */
  function routeKey(route) {
    const r = route || {};
    if (r.kind === "chatAddress" && r.address) return `chat:${lower(r.address)}`;
    if (r.kind === "group" && r.groupId) return `group:${r.groupId}`;
    if (r.kind === "room" && r.channel) return `room:${lower(r.channel)}`;
    return "";
  }

  root.KaChatPushMap = { notificationFromPush, routeKey, shortAddress, kasFromSompi };
})(typeof self !== "undefined" ? self : globalThis);
