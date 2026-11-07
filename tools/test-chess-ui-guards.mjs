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
const stub = globalThis.__chessStub = { sends: [], confirm: true, rest: {}, mempool: {}, lookups: [] };
// The Kaspa REST API's GET /transactions/{id}: stub.rest[txId]() answers { status, json } or throws.
globalThis.fetch = async (url) => {
  const txId = decodeURIComponent(String(url).match(/\/transactions\/([^?]+)/)?.[1] || "");
  stub.lookups.push(txId);
  const answer = stub.rest[txId]?.() || { status: 404 };
  return { status: answer.status, json: async () => answer.json };
};
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
  "../engine/endpoints.js": dataModule(`export const getEndpoint = (name) => (name === "kaspaApi" ? "https://rest.test" : "");`),
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
  // A claim of ours (for a room the reducer doesn't know) the chain has not shown yet either.
  row(ME, t0 - 1_000, T.messages.claim("duel-7", "1-0"), { local: true, txId: "local-claim" }),
];
store.set("kachat-chess-arena-v1", JSON.stringify(cache));

const logs = [];
const engine = { address: ME, onBroadcastBlockHits: () => () => {}, getMempoolEntry: async (txId) => stub.mempool[txId] ?? null };
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

// --- Our unseen rows: looked up on the chain after 60 s, dropped only if they never landed --------
// (iOS 4922804 checkUnconfirmedServiceRows; loadCache timed both rows from the app's start.)
{
  const cachedRow = (txId) => JSON.parse(store.get("kachat-chess-arena-v1") || "[]").find((x) => x.txId === txId);
  clockOffset.ms = 30_000;
  ui.showChessTournaments();
  tick();
  await settle();
  r.eq(stub.lookups.length, 0, "30 s on: nothing looked up yet");
  // 61 s: the REST API can't be reached for e4; the claim is accepted, with its block time.
  const claimBlockTime = t0 + 5_000;
  stub.rest["local-e4"] = () => { throw new Error("offline"); };
  stub.rest["local-claim"] = () => ({ status: 200, json: { is_accepted: true, block_time: claimBlockTime } });
  clockOffset.ms = 61_000;
  tick();
  await settle();
  r.eq(stub.lookups.join(), "local-e4,local-claim", "61 s on: both rows looked up (a claim like a move)");
  r.check(!logs.some((l) => l.includes("local-e4")), "no answer for e4: kept");
  r.eq(cachedRow("local-claim")?.local, false, "the accepted claim is the chain's row now");
  r.eq(cachedRow("local-claim")?.blockTime, claimBlockTime, "with the block's time");
  // Not asked again on every tick: 15 s later.
  clockOffset.ms = 70_000;
  tick();
  await settle();
  r.eq(stub.lookups.length, 2, "not asked again before 15 s");
  // 77 s: not accepted, but a node's mempool holds it - another round.
  stub.rest["local-e4"] = () => ({ status: 404 });
  stub.mempool["local-e4"] = { transaction: {} };
  clockOffset.ms = 77_000;
  tick();
  await settle();
  r.eq(stub.lookups.at(-1), "local-e4", "asked again 15 s later");
  r.check(!logs.some((l) => l.includes("local-e4")), "in a mempool: kept");
  r.eq(cachedRow("local-e4")?.local, true, "still our local row");
  // 93 s: nowhere - dropped, and the board offers the move again.
  delete stub.mempool["local-e4"];
  clockOffset.ms = 93_000;
  tick();
  await settle();
  r.check(logs.some((l) => l.includes("local-e4") && l.includes("dropped")), "found nowhere: dropped");
  r.eq(cachedRow("local-e4"), undefined, "the row is gone");
  click("data-chess-t-watch", { chessTWatch: "duel-3|1-0" });
  r.check(screen.innerHTML.includes(deps.escapeHtml(T.MOVE_DROPPED_MESSAGE)), "the board says: Play it again");
  r.check(screen.innerHTML.includes("data-chess-t-status>Your move<"), "and it is our move again");
  // Played again, and this time the node never answers (SEND_OUTCOME_UNKNOWN): the move stays
  // taken until the chain settles it (iOS 4922804) - no error, no second send.
  click("data-chess-t-sq", { chessTSq: "4,1" });
  r.check(/chess-sq [a-z]+ selected/.test(screen.innerHTML), "our e2 pawn picks up");
  click("data-chess-t-sq", { chessTSq: "4,3" });
  const moveSend = stub.sends.at(-1);
  r.check(moveSend?.args.content.includes('"move"'), "the move goes out");
  const sendsBefore = stub.sends.length;
  moveSend.reject(Object.assign(new Error("This may have gone through, but the network didn't confirm it."), { code: "SEND_OUTCOME_UNKNOWN", txid: "unknown-e4" }));
  await settle();
  r.eq(stub.sends.length, sendsBefore, "an unknown outcome is not sent again");
  r.check(screen.innerHTML.includes("data-chess-t-status>Their move<"), "the move stays taken: their move");
  r.check(!screen.innerHTML.includes("chess-t-error"), "and no error shows");
  r.eq(cachedRow("unknown-e4")?.local, true, "kept as our row until the chain settles it");
  click("data-chess-t-back");
}

// --- A flagged loser can't move (iOS 4922804): a move after the flag is void on chain -------------
{
  engine.address = OPP;
  ui.resetChessTournamentsForAccount();
  click("data-chess-t-watch", { chessTWatch: "duel-1|1-0" });
  const sendsBefore = stub.sends.length;
  click("data-chess-t-sq", { chessTSq: "4,1" });   // white's e2 pawn
  r.check(!/chess-sq [a-z]+ selected/.test(screen.innerHTML), "the flagged side's piece can't be picked up");
  click("data-chess-t-sq", { chessTSq: "4,3" });
  r.eq(stub.sends.length, sendsBefore, "and no move goes out");
  engine.address = ME;
  ui.resetChessTournamentsForAccount();
}

// --- Claim win: taps while the claim is going out send one claim -----------------------------------
{
  click("data-chess-t-watch", { chessTWatch: "duel-1|1-0" });
  r.check(screen.innerHTML.includes("data-chess-t-claim"), "the flagged game's winner sees Claim win");
  // The tick posted the claim by itself (a recent flag) and it is still going out: taps add none.
  const auto = stub.sends.filter((s) => s.args.content.includes('"claim"'));
  r.eq(auto.length, 1, "the tick posted the claim by itself");
  r.check(screen.innerHTML.includes("Claiming…") && /data-chess-t-claim disabled/.test(screen.innerHTML), "the button reads Claiming… and is off while it goes out");
  click("data-chess-t-claim");
  click("data-chess-t-claim");
  r.eq(stub.sends.filter((s) => s.args.content.includes('"claim"')).length, 1, "Claim win taps while the tick's claim is going out send nothing more");
  auto[0].reject(new Error("Request timed out"));
  await settle();
  r.check(screen.innerHTML.includes(">Claim win<"), "the claim failed: Claim win again");
  const before = stub.sends.length;
  click("data-chess-t-claim");
  click("data-chess-t-claim");
  click("data-chess-t-claim");
  r.eq(stub.sends.length - before, 1, "three Claim win taps while the claim is going out: one claim transaction");
  // It failed (not sent): a tap within five seconds of it is the same claim (iOS 4922804) ...
  stub.sends.at(-1).reject(new Error("Request timed out"));
  await settle();
  click("data-chess-t-claim");
  r.eq(stub.sends.length - before, 1, "a tap within five seconds of the last claim sends nothing");
  // ... and five seconds on, the button sends again.
  clockOffset.ms += T.CLAIM_TAP_GAP_MS;
  click("data-chess-t-claim");
  r.eq(stub.sends.length - before, 2, "after a failed claim, Claim win sends again five seconds on");
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
