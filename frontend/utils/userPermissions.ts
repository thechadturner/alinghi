/**
 * User permission helpers for reader vs builder/editor.
 * Used to show "review chart design" and builder navigation only to non-readers.
 */

import type { User } from "../store/userStore";

/**
 * Returns true if the user has only "reader" permission (cannot edit/build).
 * Superusers are never considered readers for feature gating.
 */
export function isReader(currentUser: User | null): boolean {
  if (!currentUser) return true; // No user = treat as reader (no builder actions)
  if (currentUser.is_super_user === true) return false;

  const userPermissions = currentUser.permissions;
  if (typeof userPermissions === "string") {
    return userPermissions === "reader";
  }
  if (Array.isArray(userPermissions)) {
    return (
      userPermissions.length > 0 &&
      userPermissions.every((p) => p === "reader")
    );
  }
  if (typeof userPermissions === "object" && userPermissions !== null) {
    const values = Object.values(userPermissions);
    return values.length > 0 && values.every((p) => p === "reader");
  }
  return true;
}
