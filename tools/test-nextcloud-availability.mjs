// node tools/test-nextcloud-availability.mjs - Nextcloud runs only where the page's relay is the
// person's own machine: this computer or a private network address (Kaspa Quick Start, npm run dev),
// never on a site KaChat hosts, and never on testnet.
import assert from "node:assert/strict";
import { isLocalHostname, nextcloudOffReason } from "../ui/nextcloud-availability.js";

const local = [
  "localhost", "LOCALHOST", "kachat.localhost", "127.0.0.1", "127.8.9.10", "[::1]", "::1",
  "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.3.4", "100.64.0.1", "100.127.255.254",
  "kaspa-node.local", "nodebox.lan", "host.home.arpa", "box.internal", "localhost.",
  "fd12:3456::1", "[fd00::1]", "fe80::1", "::ffff:192.168.1.2",
];
for (const host of local) assert.equal(isLocalHostname(host), true, `${host} is local`);

const hosted = [
  "desktop.kachat.app", "kachat.app", "www.kachat.app", "kachat.duckdns.org", "example.com",
  "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.1.1", "100.63.0.1", "100.128.0.1", "11.0.0.1",
  "2001:db8::1", "localhost.example.com", "mylocal", "evil-localhost", "127.0.0.1.nip.io", "256.1.1.1", "",
];
for (const host of hosted) assert.equal(isLocalHostname(host), false, `${host} is not local`);

assert.equal(nextcloudOffReason({ hostname: "desktop.kachat.app" }), "hosted");
assert.equal(nextcloudOffReason({ hostname: "localhost" }), null);
assert.equal(nextcloudOffReason({ hostname: "192.168.1.20" }), null);
assert.equal(nextcloudOffReason({ testnet: true, hostname: "localhost" }), "testnet", "testnet wins everywhere");
assert.equal(nextcloudOffReason({ testnet: true, hostname: "desktop.kachat.app" }), "testnet");
console.log(`nextcloud availability: ok (${local.length} local, ${hosted.length} hosted)`);
