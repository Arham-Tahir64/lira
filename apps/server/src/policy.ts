import type { Membership } from "@lira/contracts";
import type { Identity } from "./identity.js";
import { Problem } from "./problem.js";
export function requireAdmin(member: Membership) {
  if (!["owner", "admin"].includes(member.role))
    throw new Problem(
      403,
      "forbidden",
      "Only workspace administrators can do that.",
    );
}
export function requireOwner(member: Membership) {
  if (member.role !== "owner")
    throw new Problem(403, "forbidden", "Only workspace owners can do that.");
}
export function requireRecentAuthentication(identity: Identity) {
  const now = Date.now() / 1000;
  if (
    !identity.authenticatedAt ||
    identity.authenticatedAt < now - 600 ||
    identity.authenticatedAt > now + 30
  )
    throw new Problem(
      403,
      "reauthentication_required",
      "Sign in again before changing workspace ownership or roles.",
    );
}
