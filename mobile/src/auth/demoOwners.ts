// The seeded demo owners, in the order the sign-in screen offers them. Kept pure
// so the list and its labels can be tested without the session or the server.
export type DemoOwnerKey = "pro" | "business" | "free" | "email";

export type DemoOwner = {
  key: DemoOwnerKey;
  label: string;
};

export const DEMO_OWNERS: readonly DemoOwner[] = [
  { key: "pro", label: "Pro demo owner" },
  { key: "business", label: "Business demo owner" },
  { key: "free", label: "Free demo owner" },
  { key: "email", label: "Email demo owner" }
];
