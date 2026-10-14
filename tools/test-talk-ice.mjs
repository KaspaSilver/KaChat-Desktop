// ICE servers from a Nextcloud Talk signaling answer, cleaned so a browser accepts them (a bad
// entry made new RTCPeerConnection throw and every call answered on Desktop fail at once).
import assert from "node:assert/strict";
import { usableIceServers, FALLBACK_ICE_SERVERS } from "../ui/talk.js";

const urls = (list) => list.map((s) => s.urls).flat();
assert.deepEqual(urls(usableIceServers({ stunservers: [{ urls: ["stun:stun.nextcloud.com:443"] }] })), ["stun:stun.nextcloud.com:443"]);
// a bare host:port gets its scheme
assert.deepEqual(urls(usableIceServers({ stunservers: [{ urls: ["stun.example.com:3478"] }] })), ["stun:stun.example.com:3478"]);
assert.deepEqual(urls(usableIceServers({ stunservers: [{ url: "stun.example.com" }] })), ["stun:stun.example.com"]);
// TURN without (or with empty) credentials is dropped; with them it stays
const turnless = usableIceServers({ stunservers: [], turnservers: [{ urls: ["turn:t.example.com:3478"] }, { urls: ["turn:t2.example.com"], username: "", credential: "" }] });
assert.deepEqual(turnless, FALLBACK_ICE_SERVERS, "nothing usable left: Nextcloud's public STUN");
const turn = usableIceServers({ turnservers: [{ urls: ["t.example.com:3478?transport=udp"], username: "u", credential: "p" }] });
assert.deepEqual(turn, [{ urls: ["turn:t.example.com:3478?transport=udp"], username: "u", credential: "p" }]);
// junk and wrong-kind schemes go
assert.deepEqual(urls(usableIceServers({ stunservers: [{ urls: ["turn:wrong-list.example.com", ""] }] })), urls(FALLBACK_ICE_SERVERS));
assert.deepEqual(usableIceServers(null), FALLBACK_ICE_SERVERS);
console.log("talk ice servers: ok");
