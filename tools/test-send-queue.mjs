// The per-address send queue (engine/transactions.js enqueueSend): strictly one send at a time per
// address; a send stuck past its own running window lets exactly the next one start (DSK-048).
import assert from "node:assert/strict";
import { enqueueSend } from "../engine/transactions.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Order and isolation: same address runs in turn, another address does not wait, a failure does
// not block the next.
{
  const order = [];
  const a = enqueueSend("x", async () => { await sleep(30); order.push("a"); return 1; });
  const b = enqueueSend("x", async () => { order.push("b"); throw new Error("boom"); });
  const c = enqueueSend("x", async () => { order.push("c"); return 3; });
  const d = enqueueSend("y", async () => { order.push("d"); return 4; });
  const res = await Promise.allSettled([a, b, c, d]);
  assert.deepEqual(order, ["d", "a", "b", "c"]);
  assert.deepEqual(res.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(res[0].value, 1);
}
// Never two at once on one address: the running count stays 1 even with a burst.
{
  let running = 0, peak = 0;
  const job = async () => { running += 1; peak = Math.max(peak, running); await sleep(5); running -= 1; };
  await Promise.all(Array.from({ length: 8 }, () => enqueueSend("z", job)));
  assert.equal(peak, 1);
}
console.log("send queue: ok");
setTimeout(() => process.exit(0), 10);
