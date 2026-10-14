// A node that answered something impossible is out of Automatic's races for the session (DSK-046
// run 7): out of the known/remembered list, and removed from the saved one.
import assert from "node:assert/strict";
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { knownPublicNodes, markBadNode, PUBLIC_NODE_SEEDS } = await import("../engine/rpc.js");

const bad = PUBLIC_NODE_SEEDS[0];
store.set("kachat-public-nodes-seen", JSON.stringify([bad, PUBLIC_NODE_SEEDS[1]]));
assert.ok(knownPublicNodes().includes(bad), "before: the node is a candidate");
markBadNode(bad.toUpperCase());
assert.ok(!knownPublicNodes().includes(bad), "after: never a candidate again this session");
assert.ok(!JSON.parse(store.get("kachat-public-nodes-seen")).includes(bad), "and gone from the saved list");
assert.ok(knownPublicNodes().includes(PUBLIC_NODE_SEEDS[1]), "the others stay");
console.log("bad node: ok");
