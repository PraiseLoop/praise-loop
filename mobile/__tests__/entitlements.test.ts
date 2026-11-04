import { createApiClient } from "../src/api/client";
import { fetchEntitlements } from "../src/api/entitlements";

const usage = {
  businessId: 1,
  name: "Cafe",
  timezone: "America/Toronto",
  resetsOn: "2026-11-02",
  allocated: 0,
  target: 1,
  weeklyTarget: 1,
  quotaMet: false
};

const limits = { postsPerWeek: 2, templates: 2, watermark: false, reviewSync: true, aiReplies: true, brandVoice: true, businesses: 2 };

function client(body: unknown) {
  return createApiClient({
    baseUrl: "http://localhost:3000",
    getToken: () => "mobile-token",
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as typeof fetch
  });
}

describe("entitlements API", () => {
  it("accepts a plan this build does not know", async () => {
    const plan = await fetchEntitlements(client({ plan: "team", source: "manual", expiresAt: null, expired: false, limits, usage: [usage] }));
    expect(plan.plan).toBe("team");
    expect(plan.limits.brandVoice).toBe(true);
  });

  it("accepts an optional paused flag and still works without it", async () => {
    const paused = await fetchEntitlements(client({ plan: "free", source: "default", expiresAt: null, expired: false, limits, usage: [{ ...usage, paused: true }] }));
    expect(paused.usage[0].paused).toBe(true);
    const older = await fetchEntitlements(client({ plan: "free", source: "default", expiresAt: null, expired: false, limits, usage: [usage] }));
    expect(older.usage[0].paused).toBeUndefined();
  });

  it("rejects a response with no limits", async () => {
    await expect(fetchEntitlements(client({ plan: "pro", source: "default", expiresAt: null, expired: false, usage: [] }))).rejects.toThrow(
      "The server returned an invalid plan."
    );
  });

  it("rejects an empty plan name", async () => {
    await expect(fetchEntitlements(client({ plan: "  ", source: "default", expiresAt: null, expired: false, limits, usage: [] }))).rejects.toThrow(
      "The server returned an invalid plan."
    );
  });
});
