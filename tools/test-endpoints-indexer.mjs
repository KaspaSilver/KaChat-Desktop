// KaChat's indexer moved from kachat.duckdns.org to indexer.kachat.app (iOS, 2026-10-28): every
// mainnet default is the new name, a field still on the old name moves to it (in any spelling),
// and a custom server is kept.
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
store.set("kachat-endpoints-v1", JSON.stringify({
  kasiaIndexer: "https://kachat.duckdns.org/",
  pushIndexer: "kachat.duckdns.org",
  kapostIndexer: "https://my-indexer.example.com",
  translationService: "HTTPS://KACHAT.DUCKDNS.ORG",
}));

const endpoints = await import("../engine/endpoints.js");
const { getEndpoint, getEndpointOverride, ENDPOINT_DEFAULTS, DEFAULT_MAINNET_INDEXER, isRetiredDuckDnsIndexer } = endpoints;

assert.equal(DEFAULT_MAINNET_INDEXER, "https://indexer.kachat.app");
for (const key of ["kasiaIndexer", "kapostIndexer", "broadcastIndexer", "pushIndexer", "kachatNamesIndexer", "translationService"]) {
  assert.equal(ENDPOINT_DEFAULTS[key], "https://indexer.kachat.app", `${key} default`);
}

// The old name, however it was written, goes back to the default; a custom server stays.
assert.equal(getEndpoint("kasiaIndexer"), "https://indexer.kachat.app");
assert.equal(getEndpoint("pushIndexer"), "https://indexer.kachat.app");
assert.equal(getEndpoint("translationService"), "https://indexer.kachat.app");
assert.equal(getEndpointOverride("kasiaIndexer"), "");
assert.equal(getEndpoint("kapostIndexer"), "https://my-indexer.example.com");
// The names field starts as a copy of the message indexer - not the old name.
assert.equal(getEndpoint("kachatNamesIndexer"), "https://indexer.kachat.app");
const saved = JSON.parse(store.get("kachat-endpoints-v1"));
assert.equal(saved.kasiaIndexer, undefined);
assert.equal(saved.kapostIndexer, "https://my-indexer.example.com");

assert.equal(isRetiredDuckDnsIndexer("https://kachat.duckdns.org"), true);
assert.equal(isRetiredDuckDnsIndexer("https://tnkachat.duckdns.org:7443"), false);
assert.equal(isRetiredDuckDnsIndexer("https://indexer.kachat.app"), false);
assert.equal(isRetiredDuckDnsIndexer(""), false);

console.log("endpoints indexer: ok");
