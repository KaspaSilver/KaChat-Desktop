// The photo rule (KaChat-iPhone d1844582 ContactsManager.photosUnlockDate). No network. Run from the
// repo root:
//
//   node tools/test-photo-unlock.mjs

import assert from "node:assert/strict";
import { PHOTO_UNLOCK_DELAY_MS, photosUnlockTime, photosAreHidden } from "../ui/photo-unlock.js";

assert.equal(PHOTO_UNLOCK_DELAY_MS, 10 * 60 * 1000);

const out = (createdAt, extra = {}) => ({ direction: "outgoing", status: "confirmed", createdAt, ...extra });
const inc = (createdAt, extra = {}) => ({ direction: "incoming", status: "confirmed", createdAt, ...extra });

// Until both of you have sent one, there is no date.
assert.equal(photosUnlockTime([]), null);
assert.equal(photosUnlockTime(null), null);
assert.equal(photosUnlockTime([inc(100)]), null);
assert.equal(photosUnlockTime([out(100), out(200)]), null);

// The later of the two firsts, whichever side wrote first and whatever the order.
assert.equal(photosUnlockTime([out(100), inc(300), out(500), inc(700)]), 300 + PHOTO_UNLOCK_DELAY_MS);
assert.equal(photosUnlockTime([inc(900), inc(100), out(400)]), 400 + PHOTO_UNLOCK_DELAY_MS);

// Handshakes don't count, on either side.
assert.equal(photosUnlockTime([out(100, { messageType: "handshake" }), inc(200)]), null);
assert.equal(photosUnlockTime([out(100), inc(200, { messageType: "handshake" })]), null);
assert.equal(photosUnlockTime([out(100, { messageType: "handshake" }), out(250), inc(200)]), 250 + PHOTO_UNLOCK_DELAY_MS);

// Failed and still-going-out messages don't count; sent ones do, a payment like any other.
for (const status of ["failed", "draft", "building", "signing", "broadcasting", "pending"]) {
  assert.equal(photosUnlockTime([out(100, { status }), inc(200)]), null, status);
}
assert.equal(photosUnlockTime([out(100, { status: "broadcast" }), inc(200)]), 200 + PHOTO_UNLOCK_DELAY_MS);
assert.equal(photosUnlockTime([out(100, { messageType: "payment" }), inc(200)]), 200 + PHOTO_UNLOCK_DELAY_MS);

// A message with no usable time is left out rather than unlocking at the epoch.
assert.equal(photosUnlockTime([out(0), inc(200)]), null);

// Hidden while unknown or still ahead; showing from the moment itself.
assert.equal(photosAreHidden(null, 5), true);
assert.equal(photosAreHidden(10, 9), true);
assert.equal(photosAreHidden(10, 10), false);
assert.equal(photosAreHidden(10, 11), false);

console.log("photo-unlock: ok");
