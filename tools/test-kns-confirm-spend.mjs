// Registering a .kas domain and editing its profile pay KAS, so they ask first like every send
// (owner, 2026-10-23); a profile save of several fields asks once, and a refusal builds nothing.
import assert from "node:assert/strict";
import { KaspaEngine } from "../engine/index.js";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

function fakeEngine(answer) {
  const asked = [];
  const steps = [];
  const engine = Object.create(KaspaEngine.prototype);
  engine.authorizeSpend = async (details) => { asked.push(details); return answer; };
  engine.requireWallet = () => { steps.push("requireWallet"); };
  engine.connect = async () => { steps.push("connect"); throw new Error("stop here"); };
  return { engine, asked, steps };
}

await test("registering a domain asks first, naming it", async () => {
  const { engine, asked, steps } = fakeEngine(true);
  await assert.rejects(engine.inscribeKnsDomain(" MyName "), /stop here/);
  assert.equal(asked.length, 1);
  assert.match(asked[0].confirm.message, /myname\.kas/);
  assert.deepEqual(steps, ["requireWallet", "connect"]);
});

await test("a refused registration builds nothing", async () => {
  const { engine, steps } = fakeEngine(false);
  await assert.rejects(engine.inscribeKnsDomain("myname"), (error) => error.code === "SEND_CANCELLED");
  assert.deepEqual(steps, []);
});

await test("one profile field asks on its own; a batch asks once and its writes don't ask again", async () => {
  const { engine, asked } = fakeEngine(true);
  await assert.rejects(engine.submitKnsProfileField("asset", "bio", "hi"), /stop here/);
  assert.equal(asked.length, 1);
  await engine.confirmKnsProfileUpdate(3);
  assert.match(asked[1].confirm.message, /3 profile fields/);
  await assert.rejects(engine.submitKnsProfileField("asset", "bio", "hi", { confirmed: true }), /stop here/);
  await assert.rejects(engine.submitKnsProfileFields("asset", { bio: "a", x: "b" }, { confirmed: true }), /stop here/);
  assert.equal(asked.length, 2);
  await assert.rejects(engine.submitKnsProfileFields("asset", { bio: "a", x: "b" }), /stop here/);
  assert.match(asked[2].confirm.message, /2 profile fields/);
});

await test("with no password set (no authorizeSpend) nothing asks", async () => {
  const { engine, steps } = fakeEngine(true);
  engine.authorizeSpend = undefined;
  await assert.rejects(engine.inscribeKnsDomain("myname"), /stop here/);
  assert.deepEqual(steps, ["requireWallet", "connect"]);
});

console.log(`\n${passed} passed`);
