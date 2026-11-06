import assert from "node:assert/strict";
import {
  connectionView,
  isMetaAuthorizeUrl,
  outcomeMessage,
  pageCanPublish,
  parseTargetValue,
  readTarget,
  targetErrorMessage,
  targetLabel,
  targetOptions,
  targetValue,
  type MetaPageView
} from "../lib/meta/connectionsView";

// Pure rules behind the web Meta (Instagram / Facebook) connections screen (#234).
// The routes are covered by scripts/test-meta-connect.ts; this suite checks only the
// state and wording decisions the page makes. No Meta call is possible.
function page(overrides: Partial<MetaPageView> = {}): MetaPageView {
  return {
    id: 11,
    pageId: "synthetic-page",
    name: "Synthetic Page",
    instagramBusinessAccountId: "synthetic-ig",
    tasks: ["CREATE_CONTENT"],
    status: "active",
    ...overrides
  };
}

function main() {
  // Fixed callback outcomes, and nothing for an unknown value.
  assert.match(outcomeMessage("connected") ?? "", /Instagram and Facebook are connected/);
  assert.match(outcomeMessage("no_pages") ?? "", /no Facebook Pages/);
  assert.ok(outcomeMessage("denied")?.includes("didn’t approve"));
  assert.ok(outcomeMessage("expired")?.includes("took too long"));
  assert.ok(outcomeMessage("failed")?.includes("finish connecting"));
  assert.ok(outcomeMessage("not_configured")?.includes("isn’t set up"));
  assert.match(outcomeMessage("plan_required") ?? "", /Pro and Business/);
  assert.equal(outcomeMessage("bogus"), null);
  assert.equal(outcomeMessage(""), null);
  assert.equal(outcomeMessage(null), null);
  assert.equal(outcomeMessage(undefined), null);

  // Every target error code becomes a plain sentence, never the raw code.
  for (const code of ["not_configured", "plan_required", "expired", "failed", "not_connected", "needs_reconnect", "not_found", "invalid_target", "instagram_unavailable", "page_cannot_publish"]) {
    const message = targetErrorMessage(code);
    assert.ok(message.length > 20, `${code} has a plain sentence`);
    assert.ok(!message.includes("_"), `${code} does not leak the raw code`);
  }
  assert.equal(targetErrorMessage("unknown"), targetErrorMessage("not_a_code"));
  assert.equal(targetErrorMessage(null), targetErrorMessage(""));

  // Fail closed: not configured is never treated as connected, and a missing
  // status on a connection is a reconnect, not ready.
  assert.equal(connectionView({ configured: false, connected: false, status: null, pages: [] }), "not_available");
  assert.equal(connectionView({ configured: true, connected: false, status: null, pages: [] }), "not_connected");
  assert.equal(connectionView({ configured: true, connected: true, status: "active", pages: [] }), "active");
  assert.equal(connectionView({ configured: true, connected: true, status: "needs_reconnect", pages: [] }), "needs_reconnect");
  assert.equal(connectionView({ configured: true, connected: true, status: null, pages: [] }), "needs_reconnect");

  // A Page can publish only with a create-content task.
  assert.equal(pageCanPublish(page()), true);
  assert.equal(pageCanPublish(page({ tasks: ["MANAGE"] })), true);
  assert.equal(pageCanPublish(page({ tasks: ["ANALYZE"] })), false);
  assert.equal(pageCanPublish(page({ tasks: [] })), false);

  // Target values round-trip and reject anything malformed.
  assert.equal(targetValue(11, "instagram"), "11:instagram");
  assert.deepEqual(parseTargetValue("11:facebook"), { metaPageId: 11, target: "facebook" });
  for (const bad of ["", "11", ":instagram", "0:instagram", "-1:instagram", "11:store", "11:instagram:extra", "abc:facebook", null, undefined]) {
    assert.equal(parseTargetValue(bad), null, `rejects ${String(bad)}`);
  }

  // One option per usable target; Instagram appears only with a linked account,
  // and an unusable Page stays visible but disabled so the owner sees why.
  const options = targetOptions([
    page(),
    page({ id: 12, pageId: "facebook-only", name: "Facebook Only", instagramBusinessAccountId: null }),
    page({ id: 13, pageId: "read-only", name: "Read Only", tasks: ["ANALYZE"] }),
    page({ id: 14, pageId: "stale", name: "Stale Page", status: "needs_reconnect" })
  ]);
  assert.deepEqual(options.map(option => option.value), [
    "11:instagram", "11:facebook",
    "12:facebook",
    "13:instagram", "13:facebook",
    "14:instagram", "14:facebook"
  ]);
  assert.equal(options.find(option => option.value === "11:instagram")?.disabled, false);
  assert.equal(options.find(option => option.value === "13:facebook")?.disabled, true);
  assert.match(options.find(option => option.value === "13:facebook")?.reason ?? "", /allow PraiseLoop to post/);
  assert.equal(options.find(option => option.value === "14:facebook")?.disabled, true);
  assert.match(options.find(option => option.value === "14:facebook")?.reason ?? "", /needs reconnecting/);
  assert.equal(targetLabel(page(), "instagram"), "Synthetic Page (Instagram)");
  assert.equal(targetLabel(page(), "facebook"), "Synthetic Page (Facebook)");

  // The saved-target response is parsed defensively.
  const saved = readTarget({
    target: "instagram",
    page: { id: 11, pageId: "synthetic-page", name: "Synthetic Page", instagramBusinessAccountId: "ig", tasks: ["CREATE_CONTENT"], status: "active" }
  });
  assert.deepEqual(saved, { target: "instagram", page: page({ instagramBusinessAccountId: "ig" }) });
  assert.equal(readTarget({ target: "store", page: page() }), null);
  assert.equal(readTarget({ target: "facebook", page: { id: 0 } }), null);
  assert.equal(readTarget(null), null);
  assert.equal(readTarget("target"), null);

  // Only Meta's own HTTPS login dialog is a valid place to send the browser.
  assert.equal(isMetaAuthorizeUrl("https://www.facebook.com/v27.0/dialog/oauth?client_id=x&state=y"), true);
  for (const bad of [
    "http://www.facebook.com/v27.0/dialog/oauth",
    "https://www.facebook.com.evil.example/v27.0/dialog/oauth",
    "https://evil.example/v27.0/dialog/oauth?next=https://www.facebook.com",
    "https://user:pass@www.facebook.com/v27.0/dialog/oauth",
    "https://www.facebook.com:8443/v27.0/dialog/oauth",
    "https://www.facebook.com/dialog/oauth",
    "https://www.facebook.com/v27.0/dialog/oauth/extra",
    "javascript:alert(1)",
    "//www.facebook.com/v27.0/dialog/oauth",
    "",
    null,
    undefined,
    42
  ]) {
    assert.equal(isMetaAuthorizeUrl(bad), false, `refuses ${String(bad)}`);
  }

  console.log("meta connections view pure tests passed");
}
main();
