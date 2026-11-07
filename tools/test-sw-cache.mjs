// node tools/test-sw-cache.mjs - what public/sw.js puts in the shell cache. The worker runs in a
// sandbox with stub caches and fetch; nothing leaves the machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://desktop.kachat.app";

const stored = new Map();
const listeners = {};
const sandbox = {
  URL,
  console,
  importScripts() {},
  self: {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    skipWaiting() {},
    addEventListener(type, fn) { listeners[type] = fn; },
  },
  caches: {
    async open() {
      return {
        async match(request) { return stored.get(typeof request === "string" ? request : request.url) || undefined; },
        async put(request, response) { stored.set(request.url, response); },
      };
    },
    async keys() { return []; },
  },
  fetch: async () => ({ ok: true, type: "basic", clone() { return this; } }),
};
vm.runInNewContext(readFileSync(path.join(root, "public/sw.js"), "utf8"), sandbox);

async function fetchThrough(url, { cache = "default", mode = "cors" } = {}) {
  let responded = null;
  listeners.fetch({ request: { url, method: "GET", cache, mode }, respondWith(promise) { responded = promise; } });
  if (responded) await responded;
  return Boolean(responded);
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}

await test("a fresh-on-purpose request (version.json?t=..., cache: no-store) is never cached", async () => {
  for (let i = 0; i < 3; i += 1) await fetchThrough(`${ORIGIN}/version.json?t=${1000 + i}`, { cache: "no-store" });
  assert.equal([...stored.keys()].filter((key) => key.includes("version.json")).length, 0);
});

await test("the page and the app's files are still cached for offline", async () => {
  assert.equal(await fetchThrough(`${ORIGIN}/`, { mode: "navigate" }), true);
  assert.equal(await fetchThrough(`${ORIGIN}/assets/index-abc123.js`), true);
  assert.ok(stored.has(`${ORIGIN}/`));
  assert.ok(stored.has(`${ORIGIN}/assets/index-abc123.js`));
});

await test("the Nextcloud relay and other sites are left to the network", async () => {
  assert.equal(await fetchThrough(`${ORIGIN}/nc-proxy/https%3A%2F%2Fcloud.test/status.php`), false);
  assert.equal(await fetchThrough("https://api.example.com/x"), false);
});

console.log(`\n${passed} passed`);
