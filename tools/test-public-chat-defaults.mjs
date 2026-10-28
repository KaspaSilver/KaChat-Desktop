// Public Chats' default rooms (iOS 865c9ab / d37f64d): every default room joined from the start,
// #kaspa and #kachat-bugs notifying once per wallet, the language rooms ordered as iOS lists them,
// and the Languages switch's helpers. Drives ui/broadcasts.js with the DOM stubbed out (no list
// is mounted: the app draws the rooms as circles from chatCircleRooms). Run from the repo root:
//
//   node tools/test-public-chat-defaults.mjs

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};
const noop = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = noop;
globalThis.matchMedia = () => ({ matches: false, addEventListener: noop });
globalThis.document = {
  hidden: true, // keeps the closed-room sweep from fetching
  addEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, dataset: {}, setAttribute: noop, addEventListener: noop, appendChild: noop, remove: noop }),
  body: { appendChild: noop },
};

const { FEATURED_BROADCAST_CHANNELS, LANGUAGE_BROADCAST_CHANNELS } = await import("../engine/broadcasts.js");
const rooms = await import("../ui/broadcasts.js");

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

const engine = { address: "kaspa:qwalletone", onConnectionState: noop, onBroadcastBlockHits: noop, setBroadcastScanChannels: noop };
const scoped = (key) => (engine.address ? `acct:${engine.address}:${key}` : key);
let pushSyncs = 0;
rooms.initBroadcasts({
  engine,
  accountScopedKey: scoped,
  escapeHtml: (value) => String(value),
  onPushPreferencesChanged: () => { pushSyncs += 1; },
  onUnreadChanged: noop,
});

const byName = () => new Map(rooms.chatCircleRooms().map((room) => [room.name, room]));
const notifyStore = () => JSON.parse(localStorage.getItem(scoped("kachat-broadcast-notify-v1")) || "{}");

// --- every default room is in the list, joined -----------------------------------------------------
{
  const listed = byName();
  for (const name of [...FEATURED_BROADCAST_CHANNELS, ...LANGUAGE_BROADCAST_CHANNELS]) {
    r.check(listed.get(name)?.joined === true, `${name} is joined and listed`);
  }
  r.eq(rooms.anyLanguageRoomOn(), true, "Languages reads on with every language room in");
}

// --- #kaspa and #kachat-bugs notify; the language rooms do not ---------------------------------------
{
  const listed = byName();
  for (const name of FEATURED_BROADCAST_CHANNELS) r.eq(listed.get(name).notify, true, `${name} bell on`);
  for (const name of LANGUAGE_BROADCAST_CHANNELS) r.eq(listed.get(name).notify, false, `${name} bell off`);
  r.eq(localStorage.getItem(scoped("kaposts_broadcast_default_bells")), "1", "applied flag stored, account-scoped");
  r.eq(notifyStore().kaspa, true, "the bell is saved");
  r.check(pushSyncs > 0, "the push registration hears about it");
  r.eq(rooms.broadcastPushWatch().channels.join(","), [...FEATURED_BROADCAST_CHANNELS].sort().join(","), "push watches only the two bells");
}

// --- once per wallet: a bell switched off stays off -------------------------------------------------
{
  rooms.setBroadcastRoomNotify("kaspa", false);
  rooms.refreshBroadcasts(); // reloads state from storage, as showing Chats does
  r.eq(byName().get("kaspa").notify, false, "#kaspa stays off after the user turned it off");
  r.eq(byName().get("kachat-bugs").notify, true, "#kachat-bugs still on");
}

// --- the language rooms keep iOS's order while nobody has written in them -------------------------
{
  const circles = rooms.chatCircleRooms().filter((room) => LANGUAGE_BROADCAST_CHANNELS.includes(room.name));
  const order = [...circles].sort((a, b) => b.lastAt - a.lastAt).map((room) => room.name);
  r.eq(order.join(","), LANGUAGE_BROADCAST_CHANNELS.join(","), "languageChannels order");
  r.check(circles.every((room) => room.lastAt < 0), "after every room with activity (they sort last)");
}

// --- Languages switch off: every language room out at once, bells off ----------------------------
{
  rooms.setBroadcastRoomNotify("kaspa-german", true);
  rooms.setAllLanguageRooms(false);
  const listed = byName();
  r.eq(rooms.anyLanguageRoomOn(), false, "Languages reads off");
  r.check(LANGUAGE_BROADCAST_CHANNELS.every((name) => !listed.has(name)), "no language room listed");
  r.check(FEATURED_BROADCAST_CHANNELS.every((name) => listed.has(name)), "the featured rooms stay");
  r.eq(notifyStore()["kaspa-german"], undefined, "a language room's bell goes off with it");
  rooms.refreshBroadcasts();
  r.check(LANGUAGE_BROADCAST_CHANNELS.every((name) => !byName().has(name)), "switched-off rooms are not re-joined on load");
}

// --- Languages switch on: all back, then one switched off on its own ------------------------------
{
  rooms.setAllLanguageRooms(true);
  r.eq(rooms.anyLanguageRoomOn(), true, "Languages reads on again");
  r.check(LANGUAGE_BROADCAST_CHANNELS.every((name) => byName().get(name)?.joined), "every language room back");
  r.check(LANGUAGE_BROADCAST_CHANNELS.every((name) => !byName().get(name).notify), "back with the bell a new room gets (off)");
  rooms.removeBroadcastRooms(["kaspa-korean"]); // Delete on a default room switches it off
  r.eq(byName().has("kaspa-korean"), false, "one language off");
  r.eq(rooms.anyLanguageRoomOn(), true, "Languages stays on while any language is on");
}

// --- a second wallet gets its own once ----------------------------------------------------------
{
  engine.address = "kaspa:qwallettwo";
  rooms.resetBroadcastsForAccount();
  const listed = byName();
  r.eq(listed.get("kaspa").notify, true, "wallet two: #kaspa on");
  r.eq(listed.get("kachat-bugs").notify, true, "wallet two: #kachat-bugs on");
  r.check(LANGUAGE_BROADCAST_CHANNELS.every((name) => listed.get(name)?.joined), "wallet two: every language room in (wallet one's switches are its own)");
  engine.address = "kaspa:qwalletone";
  rooms.resetBroadcastsForAccount();
  r.eq(byName().get("kaspa").notify, false, "back on wallet one: its choice kept");
}

// --- no wallet yet: nothing is applied under an unscoped key ------------------------------------
{
  engine.address = "";
  rooms.resetBroadcastsForAccount();
  r.eq(localStorage.getItem("kaposts_broadcast_default_bells"), null, "no unscoped flag");
}

if (r.fail) {
  console.error(`FAIL ${r.fail} of ${r.pass + r.fail}`);
  for (const failure of r.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`ok ${r.pass} checks`);
process.exit(0); // the module's sweep interval would otherwise keep node alive
