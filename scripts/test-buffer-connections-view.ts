import assert from "node:assert/strict";
import {
  channelErrorMessage,
  channelOptionLabel,
  connectionView,
  createRequestGuard,
  isPersonalInstagram,
  outcomeMessage,
  shouldReloadConnection,
  type BufferChannel
} from "../lib/buffer/connectionsView";

// Pure rules behind the web Buffer connections screen (#29 part 2). The API
// routes are covered by scripts/test-buffer-connect.ts; this suite only checks
// the wording and state decisions the page makes.
function main() {
  // Fixed outcome codes from the callback, and nothing for an unknown value.
  assert.equal(outcomeMessage("connected"), "Buffer is connected.");
  assert.ok(outcomeMessage("denied")?.includes("didn’t approve"));
  assert.ok(outcomeMessage("expired")?.includes("took too long"));
  assert.ok(outcomeMessage("failed")?.includes("finish connecting"));
  assert.ok(outcomeMessage("not_configured")?.includes("isn’t set up"));
  assert.equal(outcomeMessage("bogus"), null);
  assert.equal(outcomeMessage(""), null);
  assert.equal(outcomeMessage(null), null);
  assert.equal(outcomeMessage(undefined), null);

  // Every channel error code gets a sentence; unknown codes get the fallback.
  for (const code of ["invalid_channel", "not_found", "not_connected", "needs_reconnect", "connection_changed"]) {
    const message = channelErrorMessage(code);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 20, `${code} has a plain sentence`);
    assert.ok(!message.includes("_"), `${code} does not leak the raw code`);
  }
  assert.equal(channelErrorMessage("unknown"), channelErrorMessage("not_a_code"));
  assert.equal(channelErrorMessage(null), channelErrorMessage(""));
  assert.equal(shouldReloadConnection("needs_reconnect"), true);
  assert.equal(shouldReloadConnection("connection_changed"), true);
  assert.equal(shouldReloadConnection("invalid_channel"), false);
  assert.equal(shouldReloadConnection("not_found"), false);
  assert.equal(shouldReloadConnection(null), false);

  // Three screen states, failing closed when the server is inconsistent.
  assert.equal(connectionView({ connected: false, status: null, channels: [] }), "not_connected");
  assert.equal(connectionView({ connected: true, status: "active", channels: [] }), "active");
  assert.equal(connectionView({ connected: true, status: "needs_reconnect", channels: [] }), "needs_reconnect");
  assert.equal(connectionView({ connected: true, status: null, channels: [] }), "needs_reconnect");

  // Only Instagram channels below Business are personal; Facebook and Business
  // Instagram are not, and a missing channel is not.
  assert.equal(isPersonalInstagram({ service: "instagram", type: "personal" }), true);
  assert.equal(isPersonalInstagram({ service: "instagram", type: "" }), true);
  assert.equal(isPersonalInstagram({ service: "instagram", type: "business" }), false);
  assert.equal(isPersonalInstagram({ service: "facebook", type: "page" }), false);
  assert.equal(isPersonalInstagram(null), false);
  assert.equal(isPersonalInstagram(undefined), false);

  const channel: BufferChannel = { id: "c1", name: "Synthetic Channel", service: "instagram", type: "business" };
  assert.equal(channelOptionLabel(channel), "Synthetic Channel (Instagram)");
  assert.equal(channelOptionLabel({ ...channel, service: "facebook" }), "Synthetic Channel (Facebook)");

  // The out-of-order guard: only the newest request may write its result.
  const guard = createRequestGuard();
  const first = guard.begin();
  assert.equal(guard.isLatest(first), true);
  const second = guard.begin();
  assert.equal(guard.isLatest(first), false, "a late response for the old selection is ignored");
  assert.equal(guard.isLatest(second), true);
  assert.equal(guard.isLatest(second + 1), false, "an invented token is not current");
  const other = createRequestGuard();
  const otherToken = other.begin();
  assert.equal(other.isLatest(otherToken), true, "each business has its own guard");

  console.log("buffer connections view pure tests passed");
}
main();
