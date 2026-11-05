import { ApiError, isSignedOut } from "../api/client";

// Kept in one place so the screen, the API call and the tests agree.
export const DELETE_ACCOUNT_CONFIRMATION = "DELETE";

export const DELETE_ACCOUNT_WARNING =
  "Deleting your account permanently removes your businesses, reviews, posts, drafts, images, sign-in methods and sessions. There is no recovery period.";

export const DELETE_ACCOUNT_SUBSCRIPTION_NOTE =
  "Deleting your account cancels a web subscription for you. It does not cancel an App Store or Google Play subscription. Cancel that in the App Store (Apple ID → Subscriptions) or Google Play (Payments & subscriptions → Subscriptions) first, otherwise the store may keep charging you.";

export function confirmsDeletion(value: string): boolean {
  return value.trim() === DELETE_ACCOUNT_CONFIRMATION;
}

// null means the session is already over (the account deletion also deleted
// this token, or it expired), so the caller should use its normal sign-out path
// rather than show a retry that can never work.
export function deletionErrorMessage(error: unknown): string | null {
  if (isSignedOut(error)) return null;
  if (error instanceof ApiError && error.kind === "http") return error.message;
  return "Couldn't delete your account. Check your connection and try again.";
}
