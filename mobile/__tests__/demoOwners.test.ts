import { DEMO_OWNERS } from "../src/auth/demoOwners";

describe("demo owner picker", () => {
  it("offers one button per seeded owner, labelled with the plan", () => {
    expect(DEMO_OWNERS.map(owner => owner.key)).toEqual(["pro", "business", "free", "email"]);
    expect(DEMO_OWNERS.map(owner => owner.label)).toEqual([
      "Pro demo owner",
      "Business demo owner",
      "Free demo owner",
      "Email demo owner"
    ]);
  });

  it("has a unique key and a non-empty label for each button", () => {
    expect(new Set(DEMO_OWNERS.map(owner => owner.key)).size).toBe(DEMO_OWNERS.length);
    expect(DEMO_OWNERS.every(owner => owner.label.trim().length > 0)).toBe(true);
  });
});
