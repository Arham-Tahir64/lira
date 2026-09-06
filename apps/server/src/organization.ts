import { createHash, randomBytes } from "node:crypto";
import type { Membership } from "@lira/contracts";
import type { Transaction } from "./database.js";
import type { Identity } from "./identity.js";
import { Problem } from "./problem.js";
import {
  requireAdmin,
  requireOwner,
  requireRecentAuthentication,
} from "./policy.js";
export function hashInvite(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export async function organizationEvent(
  tx: Transaction,
  orgId: string,
  actorId: string,
  action: string,
  changes: unknown,
) {
  await tx.query(
    "INSERT INTO app.activity_events(org_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4)",
    [orgId, actorId, action, JSON.stringify(changes)],
  );
}
export async function createInvitation(
  tx: Transaction,
  orgId: string,
  member: Membership,
  email: string,
  role: "admin" | "member",
) {
  requireAdmin(member);
  if (role === "admin") requireOwner(member);
  const normalized = email.trim().toLowerCase();
  // Expired rows leave the partial-unique slot before an administrator reissues a link.
  await tx.query(
    "UPDATE app.invitations SET revoked_at=now() WHERE org_id=$1 AND expires_at<=now() AND revoked_at IS NULL AND accepted_at IS NULL",
    [orgId],
  );
  if (
    Number(
      (
        await tx.query(
          "SELECT count(*) FROM app.invitations WHERE org_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL",
          [orgId],
        )
      ).rows[0].count,
    ) >= 100
  )
    throw new Problem(
      429,
      "invite_limit",
      "Revoke outstanding invitations before creating more.",
    );
  const token = randomBytes(32).toString("base64url");
  const result = await tx.query(
    "INSERT INTO app.invitations(org_id,email,role,token_hash,inviter_membership_id) VALUES($1,$2,$3,$4,$5) RETURNING id,email,role,expires_at,created_at",
    [orgId, normalized, role, hashInvite(token), member.id],
  );
  await organizationEvent(tx, orgId, member.id, "invitation.created", {
    invitationId: result.rows[0].id,
    role,
  });
  // Only the administrator receives this one-time response. Neither logs, events nor SQL store the raw token.
  return { ...result.rows[0], token };
}
export async function revokeInvitation(
  tx: Transaction,
  orgId: string,
  member: Membership,
  id: string,
) {
  requireAdmin(member);
  const invite = (
    await tx.query(
      "SELECT id,role FROM app.invitations WHERE org_id=$1 AND id=$2",
      [orgId, id],
    )
  ).rows[0];
  if (!invite) throw new Problem(404, "not_found", "Invitation not found.");
  if (invite.role === "admin") requireOwner(member);
  await tx.query(
    "UPDATE app.invitations SET revoked_at=coalesce(revoked_at,now()) WHERE org_id=$1 AND id=$2",
    [orgId, id],
  );
  await organizationEvent(tx, orgId, member.id, "invitation.revoked", {
    invitationId: id,
  });
}
export async function changeRole(
  tx: Transaction,
  orgId: string,
  actor: Membership,
  targetId: string,
  role: string,
  identity: Identity,
) {
  requireOwner(actor);
  requireRecentAuthentication(identity);
  const target = (
    await tx.query(
      "SELECT id,role FROM app.memberships WHERE org_id=$1 AND id=$2 AND state='active'",
      [orgId, targetId],
    )
  ).rows[0];
  if (!target) throw new Problem(404, "not_found", "Member not found.");
  await tx.query(
    "UPDATE app.memberships SET role=$3 WHERE org_id=$1 AND id=$2",
    [orgId, targetId, role],
  );
  await organizationEvent(tx, orgId, actor.id, "membership.role_changed", {
    membershipId: targetId,
    before: target.role,
    after: role,
  });
  return { id: targetId, role };
}
export async function transferOwnership(
  tx: Transaction,
  orgId: string,
  actor: Membership,
  targetId: string,
  identity: Identity,
) {
  requireOwner(actor);
  requireRecentAuthentication(identity);
  if (targetId === actor.id)
    throw new Problem(400, "invalid_target", "Choose another active member.");
  const target = (
    await tx.query(
      "SELECT id FROM app.memberships WHERE org_id=$1 AND id=$2 AND state='active'",
      [orgId, targetId],
    )
  ).rows[0];
  if (!target) throw new Problem(404, "not_found", "Member not found.");
  await tx.query(
    "UPDATE app.memberships SET role='owner' WHERE org_id=$1 AND id=$2",
    [orgId, targetId],
  );
  await tx.query(
    "UPDATE app.memberships SET role='admin' WHERE org_id=$1 AND id=$2",
    [orgId, actor.id],
  );
  await organizationEvent(
    tx,
    orgId,
    actor.id,
    "organization.ownership_transferred",
    { from: actor.id, to: targetId },
  );
}
export async function removeMember(
  tx: Transaction,
  orgId: string,
  actor: Membership,
  targetId: string,
  identity: Identity,
) {
  const target = (
    await tx.query(
      "SELECT id,role FROM app.memberships WHERE org_id=$1 AND id=$2 AND state='active'",
      [orgId, targetId],
    )
  ).rows[0];
  if (!target) throw new Problem(404, "not_found", "Member not found.");
  if (targetId !== actor.id) requireAdmin(actor);
  if (
    target.role === "owner" ||
    (target.role === "admin" && targetId !== actor.id)
  ) {
    requireOwner(actor);
    requireRecentAuthentication(identity);
  }
  const owner = (
    await tx.query(
      "SELECT id FROM app.memberships WHERE org_id=$1 AND id<>$2 AND role='owner' AND state='active' ORDER BY created_at,id LIMIT 1",
      [orgId, targetId],
    )
  ).rows[0];
  if (!owner)
    throw new Problem(
      409,
      "last_owner",
      "Add or transfer ownership before removing the last owner.",
    );
  // The exclusive organization lock serializes this cleanup with issue writes and invitation acceptance.
  const affected = await tx.query(
    `WITH changed AS (
    UPDATE app.issues SET assignee_membership_id=NULL,version=version+1,updated_at=now()
    WHERE org_id=$1 AND assignee_membership_id=$2 AND status<>'done' RETURNING id,project_id
  ), events AS (
    INSERT INTO app.activity_events(org_id,project_id,issue_id,actor_membership_id,action,changes)
    SELECT $1,project_id,id,$3,'issue.unassigned',jsonb_build_object('previousAssignee',$2::text,'reason','member_removed') FROM changed
    RETURNING id,project_id,issue_id
  ) INSERT INTO app.outbox_jobs(org_id,event_id,type,payload)
    SELECT $1,id,'issue.unassigned',jsonb_build_object('issueId',issue_id,'projectId',project_id) FROM events RETURNING id`,
    [orgId, targetId, actor.id],
  );
  await tx.query(
    "UPDATE app.projects SET lead_membership_id=$3 WHERE org_id=$1 AND lead_membership_id=$2",
    [orgId, targetId, owner.id],
  );
  await tx.query(
    "DELETE FROM app.team_members WHERE org_id=$1 AND membership_id=$2",
    [orgId, targetId],
  );
  await tx.query(
    "UPDATE app.invitations SET revoked_at=now() WHERE org_id=$1 AND inviter_membership_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL",
    [orgId, targetId],
  );
  await tx.query(
    "UPDATE app.memberships SET state='inactive',left_at=now() WHERE org_id=$1 AND id=$2",
    [orgId, targetId],
  );
  await organizationEvent(tx, orgId, actor.id, "membership.removed", {
    membershipId: targetId,
    unassignedIssues: affected.rowCount,
  });
}
