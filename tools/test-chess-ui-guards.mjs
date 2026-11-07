// Chess Online and Bots UI guards, run on the real ui/chess-tournaments.js and ui/chess-bots.js
// with the page, the dialogs and the broadcast sends stubbed: Claim win taps while a claim is
// going out send one claim; a send that lands after an account switch opens nothing for the new
// account; our unseen moves are not dropped by the first tick after Chess comes back on (no poll
// ran while it was off); a bot game's stamped win goes into the record of the account it was
// played under. Run from the repo root:
//
//   node tools/test-chess-ui-guards.mjs

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoUrl = (path) => pathToFileURL(join(here, "..", path)).href;

const r = {
  pass: 0, fail: 0, failures: [],
  check(ok, label) { if (ok) this.pass++; else { this.fail++; this.failures.push(label); } },
  eq(a, b, label) { this.check(a === b, `${label}: got ${String(a)}, expected ${String(b)}`); },
};

// --- The page around the modules ------------------------------------------------------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
let fakeNow = Date.now();
const realNow = Date.now.bind(Date);
const clockOffset = { ms: 0 };
Date.now = () => realNow() + clockOffset.ms;
const intervals = new Map();   // ms -> callback (never fired by itself)
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => { intervals.set(ms, fn); return ms; },
  clearInterval: () => {},
};
const screen = { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], addEventListener: (type, fn) => { screen.onclick = fn; } };
globalThis.document = { hidden: false, querySelector: (sel) => (sel === "[data-chess-tournaments]" ? screen : null) };

// --- Stubs for the sends, the dialogs, the endpoints and the stylesheet ---------------------------
const stub = globalThis.__chessStub = { sends: [], confirm: true };
const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const STUBS = {
  "../engine/broadcasts.js": dataModule(`
    const s = globalThis.__chessStub;
    export const hasBroadcastIndexer = () => false;
    export const fetchBroadcastHistory = async () => ({ messages: [], hasMore: false });
    export const broadcastPayloadBytes = () => 200;
    export function sendBroadcastMessage(args) {
      return new Promise((resolve, reject) => { s.sends.push({ args, resolve, reject }); });
    }`),
  "./dialogs.js": dataModule(`
    const s = globalThis.__chessStub;
    export const confirmDialog = async () => s.confirm;
    export const promptDialog = async () => null;
    export const chooseDialog = async () => null;`),
  "./broadcasts.js": dataModule(`export const setServiceScanWanted = () => {};`),
  "../engine/endpoints.js": dataModule(`export const getEndpoint = () => "";`),
  "./chess-bots.css": dataModule(``),
  // The bot games ui/chess-bots.js starts, kept for the test to look at.
  "../engine/chess-bot.js": dataModule(`
    import * as real from ${JSON.stringify(repoUrl("engine/chess-bot.js"))};
    export * from ${JSON.stringify(repoUrl("engine/chess-bot.js"))};
    export class ChessBotGame extends real.ChessBotGame {
      constructor(options) { super(options); (globalThis.__chessStub.botGames ||= []).push({ game: this, options }); }
    }`),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || "";
    if (STUBS[specifier] && /\/ui\/chess-(tournaments|bots)\.js$/.test(parent)) return { url: STUBS[specifier], shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const T = await import("../engine/chess-tournament.js");

// --- The arena this device has cached -------------------------------------------------------------
const ME = "kaspa:qme";
const OPP = "kaspa:qopponent";
const t0 = Date.now();
let txCounter = 0;
const row = (sender, blockTime, message, extra = {}) => ({ txId: extra.txId || `tx-${++txCounter}`, senderAddress: sender, content: T.encodeMessage(message), blockTime, verified: !extra.local, local: Boolean(extra.local) });
const cache = [
  // duel-1: the opponent (white) never moved and ran out of clock ten minutes on - we may claim.
  row(OPP, t0 - 10 * 60_000, T.messages.join("duel-1")),
  row(ME, t0 - 10 * 60_000 + 1_000, T.messages.join("duel-1")),
  // duel-2: one opponent waiting, a seat for us.
  row(OPP, t0 - 5_000, T.messages.join("duel-2")),
  // duel-3: we are white and played e4 a moment ago; the chain has not shown it yet.
  row(ME, t0 - 40_000, T.messages.join("duel-3")),
  row(OPP, t0 - 39_000, T.messages.join("duel-3")),
  row(ME, t0 - 2_000, T.messages.move("duel-3", "1-0", 1, "e2", "e4", null), { local: true, txId: "local-e4" }),
];
store.set("kachat-chess-arena-v1", JSON.stringify(cache));

const logs = [];
const engine = { address: ME, onBroadcastBlockHits: () => () => {} };
const scoped = (key, address = engine.address) => {
  const clean = String(address || "").trim();
  return clean ? `kachat-account-data-v1:${clean}:${key}` : key;
};
const deps = {
  engine,
  escapeHtml: (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  displayNameFor: (address) => address,
  appendEngineLog: (line) => logs.push(line),
  showToast: () => {},
  accountScopedKey: scoped,
};
const ui = await import("../ui/chess-tournaments.js");
const bots = await import("../ui/chess-bots.js");
ui.initChessTournaments(deps);

/** A click on an element carrying `attr` (and its data-* values). */
function click(attr, dataset = {}) {
  const el = { dataset };
  screen.onclick({ target: { closest: (sel) => (sel === `[${attr}]` ? el : null) } });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const tick = () => intervals.get(200)?.();

// --- Our unseen move is not dropped by the first tick after Chess comes back on -------------------
{
  // Chess was off for a minute after the app started (loadCache timed e4 from then): no poll, no scan.
  clockOffset.ms = 60_000;
  ui.showChessTournaments();
  tick();
  r.check(!logs.some((l) => l.includes("local-e4")), "first tick after Chess came back on keeps the unseen move (the indexer gets its turn)");
  r.check(!screen.innerHTML.includes("didn't reach the network"), "and says nothing about it");
  // Still unseen T.PENDING_MOVE_TIMEOUT_MS after Chess came back on: dropped, as before.
  clockOffset.ms = 60_000 + T.PENDING_MOVE_TIMEOUT_MS + 1_000;
  tick();
  r.check(logs.some((l) => l.includes("local-e4") && l.includes("dropped")), "still unseen the timeout after Chess came back on: dropped");
  clockOffset.ms = 0;
  tick();
}

// --- Claim win: taps while the claim is going out send one claim -----------------------------------
{
  click("data-chess-t-watch", { chessTWatch: "duel-1|1-0" });
  r.check(screen.innerHTML.includes("data-chess-t-claim"), "the flagged game's winner sees Claim win");
  // The tick posted the claim by itself (a recent flag) and it is still going out: taps add none.
  const auto = stub.sends.filter((s) => s.args.content.includes('"claim"'));
  r.eq(auto.length, 1, "the tick posted the claim by itself");
  click("data-chess-t-claim");
  click("data-chess-t-claim");
  r.eq(stub.sends.filter((s) => s.args.content.includes('"claim"')).length, 1, "Claim win taps while the tick's claim is going out send nothing more");
  auto[0].reject(new Error("Request timed out"));
  await settle();
  const before = stub.sends.length;
  click("data-chess-t-claim");
  click("data-chess-t-claim");
  click("data-chess-t-claim");
  r.eq(stub.sends.length - before, 1, "three Claim win taps while the claim is going out: one claim transaction");
  // It failed (not sent): the button sends again.
  stub.sends.at(-1).reject(new Error("Request timed out"));
  await settle();
  click("data-chess-t-claim");
  r.eq(stub.sends.length - before, 2, "after a failed claim, Claim win sends again");
  stub.sends.at(-1).resolve("claim-tx-2");
  await settle();
  click("data-chess-t-back");
}

// --- A send that lands after an account switch opens nothing for the new account --------------------
{
  // An account free to join (ME still has duel-3 on).
  engine.address = "kaspa:qthird";
  ui.resetChessTournamentsForAccount();
  click("data-chess-t-open", { chessTOpen: "duel-2" });
  r.check(screen.innerHTML.includes("data-chess-t-join="), "duel-2 offers Join");
  const before = stub.sends.length;
  click("data-chess-t-join", { chessTJoin: "duel-2" });
  r.eq(stub.sends.length - before, 1, "the join goes out");
  // Another account comes on while the join is out; then it lands.
  engine.address = "kaspa:qother";
  ui.resetChessTournamentsForAccount();
  r.check(screen.innerHTML.includes("KaPlay"), "the new account starts on KaPlay's games");
  stub.sends.at(-1).resolve("join-tx");
  await settle();
  r.check(!screen.innerHTML.includes("Looking for an opponent"), "the old account's join does not open its waiting room for the new account");
  r.check(screen.innerHTML.includes("KaPlay"), "the new account stays where it was");
  engine.address = ME;
  ui.resetChessTournamentsForAccount();
}

// --- A bot game's stamped win goes to the account it was played under --------------------------------
{
  click("data-chess-t-bots");
  click("data-chess-bot-open", { chessBotOpen: "1" });
  click("data-chess-bot-play");
  const played = stub.botGames?.at(-1);
  r.check(Boolean(played), "a bot game started");
  // Play again and an account switch while the first game's stamp was still going out.
  engine.address = "kaspa:qother";
  ui.resetChessTournamentsForAccount();
  played.options.recordStampedWin(9);
  played.options.record({ kind: "won", why: "checkmate" });
  const winsOf = (address) => JSON.parse(store.get(scoped("kachat-chess-bot-stamped-wins-v1", address)) || "{}");
  const recordsOf = (address) => JSON.parse(store.get(scoped("kachat-chess-bots-v1", address)) || "{}");
  r.eq(winsOf(ME)["1"]?.[0]?.moves, 9, "the stamped win is the playing account's");
  r.eq(winsOf("kaspa:qother")["1"], undefined, "and not the account on now");
  r.eq(recordsOf(ME)["1"]?.wins, 1, "the result goes to the playing account's record");
  r.eq(recordsOf("kaspa:qother")["1"], undefined, "not the new account's");
  void bots;
}

ui.hideChessTournaments();
void fakeNow;
console.log(`chess UI guards: ${r.pass} passed, ${r.fail} failed`);
if (r.fail) { for (const f of r.failures) console.log(`  FAIL ${f}`); process.exit(1); }
process.exit(0);
