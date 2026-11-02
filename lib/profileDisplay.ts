// Web-only wording and menu structure for the owner profile (#150). Pure and
// client-safe; the API shape and validation live in lib/services/profile.ts.

// Keep in step with NAME_MAX_LENGTH in lib/services/profile.ts. The server is the
// authority; this only caps the input's maxLength.
export const PROFILE_NAME_MAX = 80;
export const ADD_NAME_PROMPT = "Add your name";
export const ADD_NAME_HINT = "Your name shows in the menu and on your profile.";

// The owner's name as shown, or null when they have not set one. Callers render
// the "Add your name" prompt instead of a blank or the raw email.
export function displayName(name: string | null): string | null {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed : null;
}

export function profileLabel(name: string | null): string {
  return displayName(name) ?? ADD_NAME_PROMPT;
}

export type ProfileMenuItem = { id: "connections" | "plan" | "edit-name" | "sign-out"; label: string; href?: string };

// Everything about the owner, their connections and their plan lives under the
// profile, so the main nav keeps only the work screens (#150, #29).
export const PROFILE_MENU_ITEMS: readonly ProfileMenuItem[] = [
  { id: "connections", label: "Connections", href: "/connections" },
  { id: "plan", label: "Plan and usage", href: "/account" },
  { id: "edit-name", label: "Edit name" },
  { id: "sign-out", label: "Sign out" }
];
