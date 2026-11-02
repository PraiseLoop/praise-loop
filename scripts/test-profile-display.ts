import assert from "node:assert/strict";
import { ADD_NAME_PROMPT, PROFILE_MENU_ITEMS, PROFILE_NAME_MAX, displayName, profileLabel } from "../lib/profileDisplay";

// The web profile menu's pure rules (#150): the name fallback and the menu items.
// The API's initials, validation and sign-in rules are covered by
// scripts/test-profile.ts (#149).
function main() {
  // A missing name is null, and the label is the prompt, never the email.
  assert.equal(displayName(" Demo "), "Demo");
  assert.equal(displayName(""), null);
  assert.equal(displayName("   "), null);
  assert.equal(displayName(null), null);
  assert.equal(profileLabel(null), ADD_NAME_PROMPT);
  assert.equal(profileLabel("Demo"), "Demo");
  assert.equal(ADD_NAME_PROMPT, "Add your name");

  // The server's NAME_MAX_LENGTH is 80; the input's maxLength must match it.
  assert.equal(PROFILE_NAME_MAX, 80);

  // Connections, plan and usage under the profile, then edit name, then sign out.
  assert.deepEqual(PROFILE_MENU_ITEMS.map(item => item.id), ["connections", "plan", "edit-name", "sign-out"]);
  assert.equal(PROFILE_MENU_ITEMS.find(item => item.id === "connections")?.href, "/connections");
  assert.equal(PROFILE_MENU_ITEMS.find(item => item.id === "plan")?.href, "/account");
  assert.equal(PROFILE_MENU_ITEMS.find(item => item.id === "sign-out")?.href, undefined);
  assert.equal(new Set(PROFILE_MENU_ITEMS.map(item => item.id)).size, PROFILE_MENU_ITEMS.length);
  assert.ok(PROFILE_MENU_ITEMS.every(item => item.label.length > 0));
  console.log("profile display pure tests passed");
}
main();
