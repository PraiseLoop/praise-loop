import assert from "node:assert/strict";
import { holdsSlot, recentResults, slotTiles, toIso, type LineupDraft } from "../lib/posting/lineup";

// The Schedule page's lined-up view (#206): which posts hold a slot, and how the tiles are ordered.
const d = (id: number, o: Partial<LineupDraft> = {}): LineupDraft => ({ id, version: 1, quote_text: `Quote ${id}`, status: "scheduled", provider_state: "queued", scheduled_for: "2026-11-05 15:00:00+00", ...o });

// Postgres text timestamps, with and without minutes in the offset, parse the same.
assert.equal(toIso("2026-11-05 15:00:00+00"), "2026-11-05T15:00:00.000Z");
assert.equal(toIso("2026-11-05 11:00:00-04"), "2026-11-05T15:00:00.000Z");
assert.equal(toIso("2026-11-05 15:00:00.5+00:00"), "2026-11-05T15:00:00.500Z");
assert.equal(toIso("not a date"), null);

// Only a scheduled post the worker has not finished with holds its slot.
for (const state of ["queued", "submitting", "submitted", "unknown"]) assert.equal(holdsSlot(d(1, { provider_state: state })), true, state);
for (const state of ["sent", "error", "missed", "drafted", null, undefined]) assert.equal(holdsSlot(d(1, { provider_state: state })), false, String(state));
assert.equal(holdsSlot(d(1, { status: "approved" })), false);
assert.equal(holdsSlot(d(1, { scheduled_for: null })), false);

// Tiles merge open and taken slots in time order, so a taken slot stays where it was.
const tiles = slotTiles(["2026-11-05T10:00:00.000Z", "2026-11-07T10:00:00.000Z"], [d(1, { scheduled_for: "2026-11-06 10:00:00+00" }), d(2, { status: "approved" })]);
assert.deepEqual(tiles.map(t => [t.instant, t.draft?.id ?? null]), [["2026-11-05T10:00:00.000Z", null], ["2026-11-06T10:00:00.000Z", 1], ["2026-11-07T10:00:00.000Z", null]]);
assert.deepEqual(slotTiles([], []), []);
assert.equal(slotTiles(["2026-11-05T10:00:00.000Z"], [d(3, { scheduled_for: "garbage" })]).length, 1, "an unreadable time is left out rather than breaking the page");

// Results: posted, saved as a Buffer draft and failed posts show; queued ones do not (they are tiles); newest first, at most five.
const results = recentResults([
  d(1, { status: "published", provider_state: "sent", posting_sent_at: "2026-11-04 10:00:00+00" }),
  d(2, { status: "approved", provider_state: "drafted", scheduled_for: "2026-11-04 12:00:00+00" }),
  d(3, { status: "failed", provider_state: "error", posting_error_code: "rejected", scheduled_for: "2026-11-04 11:00:00+00" }),
  d(4, { provider_state: "queued" }),
  d(5, { status: "approved", provider_state: null }),
]);
assert.deepEqual(results.map(r => r.id), [2, 3, 1]);
assert.equal(recentResults(Array.from({ length: 9 }, (_, i) => d(i + 10, { status: "published", provider_state: "sent", posting_sent_at: `2026-11-0${(i % 9) + 1} 10:00:00+00` }))).length, 5);
console.log("schedule lineup pure tests passed");
