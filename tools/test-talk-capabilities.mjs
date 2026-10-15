// Whether a Nextcloud capabilities answer says Talk can host a KaChat call (iOS 88aa3c1): an
// answer that isn't a capabilities answer is "couldn't ask" (null), never "no Talk".
import assert from "node:assert/strict";
import { talkCallsFromCapabilities } from "../ui/talk.js";

const caps = (spreed) => ({ ocs: { data: { capabilities: spreed === undefined ? { core: {} } : { core: {}, spreed } } } });
const features = ["conversation-v4", "signaling-v3"];
assert.equal(talkCallsFromCapabilities(caps({ features })), true);
assert.equal(talkCallsFromCapabilities(caps({ features, config: { call: { enabled: true } } })), true);
assert.equal(talkCallsFromCapabilities(caps({ features, config: { call: { enabled: "1" } } })), true);
// the server answered: Talk off, missing or too old
assert.equal(talkCallsFromCapabilities(caps({ features, config: { call: { enabled: false } } })), false);
assert.equal(talkCallsFromCapabilities(caps(undefined)), false, "no spreed entry: Talk isn't installed");
assert.equal(talkCallsFromCapabilities(caps({ features: ["conversation-v4"] })), false);
// not an answer about Talk at all
assert.equal(talkCallsFromCapabilities(null), null);
assert.equal(talkCallsFromCapabilities({}), null);
assert.equal(talkCallsFromCapabilities({ ocs: { meta: { status: "failure" }, data: [] } }), null);
assert.equal(talkCallsFromCapabilities("<html>login</html>"), null);
console.log("talk capabilities: ok");
