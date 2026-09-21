import type pg from "pg";
import {
  decryptInvitation,
  type InvitationMailConfig,
} from "./invitation-email.js";
import { DeliveryError, type SendEmail } from "./email.js";
type Scope = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => Promise<T>;
export async function processInvitationEmail(
  orgId: string,
  jobId: string,
  scope: Scope,
  reserve: () => Promise<boolean>,
  config?: InvitationMailConfig,
  send?: SendEmail,
) {
  const intent = await scope(async (tx) => {
    const job = (
      await tx.query(
        "SELECT type,payload FROM app.outbox_jobs WHERE org_id=$1 AND id=$2",
        [orgId, jobId],
      )
    ).rows[0];
    if (!["invitation.email", "invitation.email_expire"].includes(job.type))
      throw new Error("unsupported_job");
    const row = (
      await tx.query(
        "SELECT * FROM app.invitation_emails WHERE org_id=$1 AND invitation_id=$2",
        [orgId, job.payload.invitationId],
      )
    ).rows[0];
    if (!row) throw new Error("missing_invitation_email");
    if (job.type === "invitation.email_expire") {
      if (new Date(row.expires_at).getTime() > Date.now())
        throw new Error("expiry_too_early");
      await tx.query(
        "UPDATE app.invitation_emails SET encrypted_payload=NULL,state=CASE WHEN state='queued' THEN 'expired' ELSE state END WHERE org_id=$1 AND invitation_id=$2",
        [orgId, row.invitation_id],
      );
      return null;
    }
    if (row.state !== "queued") return null;
    const expired = new Date(row.expires_at).getTime() <= Date.now();
    if (expired || !config) {
      await tx.query(
        "UPDATE app.invitation_emails SET state=$3,encrypted_payload=NULL WHERE org_id=$1 AND invitation_id=$2",
        [orgId, row.invitation_id, expired ? "expired" : "cancelled"],
      );
      return null;
    }
    return row;
  });
  if (!intent) return;
  if (!config || !send) throw new DeliveryError("email_unavailable");
  const request = decryptInvitation(
    intent.encrypted_payload,
    config.key,
    orgId,
    intent.invitation_id,
  );
  // Recheck access, email binding, expiry and cancellation immediately before external I/O.
  const allowed = await scope(async (tx) => {
    const current = (
      await tx.query(
        `SELECT i.id FROM app.invitations i JOIN app.memberships m ON m.org_id=i.org_id AND m.id=i.inviter_membership_id JOIN app.users u ON u.id=m.user_id JOIN app.invitation_emails e ON e.org_id=i.org_id AND e.invitation_id=i.id WHERE i.org_id=$1 AND i.id=$2 AND i.email=$3 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() AND m.state='active' AND (m.role='owner' OR (m.role='admin' AND i.role='member')) AND u.disabled_at IS NULL AND e.state='queued' AND e.expires_at>now()`,
        [orgId, intent.invitation_id, request.to[0]],
      )
    ).rowCount;
    if (!current)
      await tx.query(
        "UPDATE app.invitation_emails SET state='cancelled',encrypted_payload=NULL WHERE org_id=$1 AND invitation_id=$2 AND state='queued'",
        [orgId, intent.invitation_id],
      );
    return !!current;
  });
  if (!allowed) return;
  if (!(await reserve())) throw new DeliveryError("email_budget");
  try {
    await send(request, `invitation/${intent.event_id}`);
  } catch (error) {
    if (error instanceof DeliveryError && error.code === "email_rejected")
      await scope((tx) =>
        tx.query(
          "UPDATE app.invitation_emails SET state='failed',encrypted_payload=NULL WHERE org_id=$1 AND invitation_id=$2 AND state='queued'",
          [orgId, intent.invitation_id],
        ),
      );
    throw error;
  }
  await scope((tx) =>
    tx.query(
      "UPDATE app.invitation_emails SET state='sent',sent_at=now(),encrypted_payload=NULL WHERE org_id=$1 AND invitation_id=$2 AND state='queued'",
      [orgId, intent.invitation_id],
    ),
  );
}
