// KaChat's indexer is indexer.kachat.app (iOS, 2026-10-28): every mainnet default is that name, and
// a custom server is kept.
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
store.set("kachat-endpoints-v1", JSON.stringify({ kapostIndexer: "https://my-indexer.example.com" }));

const { getEndpoint, ENDPOINT_DEFAULTS, DEFAULT_MAINNET_INDEXER } = await import("../engine/endpoints.js");

assert.equal(DEFAULT_MAINNET_INDEXER, "https://indexer.kachat.app");
for (const key of ["kasiaIndexer", "kapostIndexer", "broadcastIndexer", "pushIndexer", "kachatNamesIndexer", "translationService"]) {
  assert.equal(ENDPOINT_DEFAULTS[key], "https://indexer.kachat.app", `${key} default`);
}
assert.equal(getEndpoint("kasiaIndexer"), "https://indexer.kachat.app");
assert.equal(getEndpoint("kapostIndexer"), "https://my-indexer.example.com");

console.log("endpoints indexer: ok");
