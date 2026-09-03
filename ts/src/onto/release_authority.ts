/**
 * Formal-release authority policy.
 *
 * Authentication already has exactly two roles (`admin | user`).  Release
 * acceptance is a control-plane mutation, so it deliberately reuses `admin`
 * instead of inventing a second permission vocabulary that could drift from
 * authgate.
 */
export const RELEASE_ACCEPTANCE_ROLE = "admin";

export function isReleaseAcceptanceAuthority(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === RELEASE_ACCEPTANCE_ROLE;
}
