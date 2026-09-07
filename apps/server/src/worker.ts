import type pg from "pg";
import { DeliveryError, type SendEmail, type EmailRequest } from "./email.js";
import { processAttachment } from "./attachment-worker.js";
import type { AttachmentOptions } from "./storage.js";
import { processExport } from "./export-worker.js";
import type { ExportStorage } from "./export-storage.js";
export interface ClaimedJob {
  id: string;
  org_id: string;
  lease_token: string;
  attempts: number;
}
export async function assertWorkerRole(pool: pg.Pool) {
  const { rows } =
    await pool.query(`SELECT r.rolsuper,r.rolbypassrls,pg_has_role(current_user,'app_worker','MEMBER') AS worker,
 EXISTS(SELECT 1 FROM pg_roles f WHERE f.rolname IN ('app_api','app_scheduler','app_bootstrap','app_invitation_accept','app_owner_guard') AND pg_has_role(current_user,f.oid,'MEMBER')) AS privileged,
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND pg_has_role(current_user,c.relowner,'USAGE')) AS owns_tables FROM pg_roles r WHERE rolname=current_user`);
  const r = rows[0];
  if (
    !r ||
    r.rolsuper ||
    r.rolbypassrls ||
    r.privileged ||
    r.owns_tables ||
    !r.worker
  )
    throw new Error("Worker requires a separate non-owner app_worker login.");
}
export async function claimJob(pool: pg.Pool): Promise<ClaimedJob | undefined> {
  return (await pool.query("SELECT * FROM app.claim_job()")).rows[0];
}
export async function finishJob(
  pool: pg.Pool,
  job: ClaimedJob,
  error: string | null = null,
) {
  return (
    await pool.query("SELECT app.finish_job($1,$2,$3) AS finished", [
      job.id,
      job.lease_token,
      error,
    ])
  ).rows[0].finished as boolean;
}
async function scoped<T>(
  pool: pg.Pool,
  job: ClaimedJob,
  fn: (tx: pg.PoolClient) => Promise<T>,
  repeatable = false,
) {
  const tx = await pool.connect();
  try {
    await tx.query(
      repeatable ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
    );
    await tx.query(
      "SELECT set_config('app.org_id',$1,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','3000',true)",
      [job.org_id],
    );
    await tx.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,1))",
      [job.org_id],
    );
    const valid = await tx.query(
      "SELECT id FROM app.outbox_jobs WHERE org_id=$1 AND id=$2 AND lease_token=$3 AND state='processing' AND lease_until>now()",
      [job.org_id, job.id, job.lease_token],
    );
    if (!valid.rowCount) throw new Error("lease_lost");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
interface Delivery {
  eventId: string;
  recipientId: string;
  request: EmailRequest;
}
export interface WorkerOptions {
  exportStorage?: ExportStorage;
  attachments?: AttachmentOptions;
  sendEmail?: SendEmail;
  emailFrom?: string;
  appUrl: string;
  emailDailyLimit?: number;
  suppressEmail?: boolean;
}
export async function processJob(
  pool: pg.Pool,
  job: ClaimedJob,
  options: WorkerOptions,
) {
  try {
    const kind = await scoped(
      pool,
      job,
      async (tx) =>
        (
          await tx.query(
            "SELECT type FROM app.outbox_jobs WHERE org_id=$1 AND id=$2",
            [job.org_id, job.id],
          )
        ).rows[0]?.type as string | undefined,
    );
    if (kind?.startsWith("export.")) {
      await processExport(
        job.org_id,
        job.id,
        (fn) => scoped(pool, job, fn),
        (fn) => scoped(pool, job, fn, true),
        options.exportStorage,
      );
      return await finishJob(pool, job);
    }
    if (kind?.startsWith("attachment.")) {
      await processAttachment(
        job.org_id,
        job.id,
        (fn) => scoped(pool, job, fn),
        options.attachments,
      );
      return await finishJob(pool, job);
    }
    const delivery = await scoped(pool, job, async (tx) => {
      const result = await tx.query(
        `SELECT j.type,e.id AS event_id,e.changes,e.actor_membership_id,e.created_at,i.id AS issue_id,i.project_id,i.assignee_membership_id,p.archived_at
    FROM app.outbox_jobs j JOIN app.activity_events e ON e.org_id=j.org_id AND e.id=j.event_id
    LEFT JOIN app.issues i ON i.org_id=e.org_id AND i.id=e.issue_id LEFT JOIN app.projects p ON p.org_id=i.org_id AND p.id=i.project_id WHERE j.org_id=$1 AND j.id=$2`,
        [job.org_id, job.id],
      );
      const event = result.rows[0];
      if (!event) throw new Error("missing_event");
      if (
        !["issue.created", "issue.updated", "issue.unassigned"].includes(
          event.type,
        )
      )
        throw new Error("unsupported_job");
      const target =
        event.type === "issue.created"
          ? event.changes.assignee_membership_id
          : event.changes.assignee_membership_id?.after;
      if (
        typeof target !== "string" ||
        target === event.actor_membership_id ||
        target !== event.assignee_membership_id ||
        event.archived_at
      )
        return null;
      const recipient = (
        await tx.query(
          `SELECT m.id,u.verified_email,u.email_verified_at,COALESCE(p.assignment_email,false) AS email_enabled
    FROM app.memberships m JOIN app.users u ON u.id=m.user_id LEFT JOIN app.notification_preferences p ON p.org_id=m.org_id AND p.membership_id=m.id
    WHERE m.org_id=$1 AND m.id=$2 AND m.state='active' AND u.disabled_at IS NULL`,
          [job.org_id, target],
        )
      ).rows[0];
      if (!recipient) return null;
      await tx.query(
        "INSERT INTO app.notifications(org_id,recipient_membership_id,event_id,project_id,issue_id,type) VALUES($1,$2,$3,$4,$5,'issue.assigned') ON CONFLICT DO NOTHING",
        [job.org_id, target, event.event_id, event.project_id, event.issue_id],
      );
      // Historical backlog produces in-app records only; never release a burst of old emails.
      if (
        options.suppressEmail ||
        !recipient.email_enabled ||
        !recipient.verified_email ||
        Date.now() - new Date(recipient.email_verified_at).getTime() >
          86400000 ||
        Date.now() - new Date(event.created_at).getTime() > 72000000
      )
        return null;
      if (!options.emailFrom) return { unavailable: true } as const;
      const request: EmailRequest = {
        from: options.emailFrom,
        to: [recipient.verified_email],
        subject: "New task assignment in Lira",
        text: `You have a new task assignment. Sign in to Lira to view your notifications: ${options.appUrl}`,
      };
      await tx.query(
        "INSERT INTO app.email_deliveries(org_id,event_id,recipient_membership_id,request) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [job.org_id, event.event_id, target, JSON.stringify(request)],
      );
      const intent = (
        await tx.query(
          "SELECT request,sent_at,created_at FROM app.email_deliveries WHERE org_id=$1 AND event_id=$2 AND recipient_membership_id=$3",
          [job.org_id, event.event_id, target],
        )
      ).rows[0];
      if (
        intent.sent_at ||
        Date.now() - new Date(intent.created_at).getTime() > 72000000 ||
        intent.request.to[0] !== recipient.verified_email
      )
        return null;
      return {
        eventId: event.event_id,
        recipientId: target,
        request: intent.request,
      } as Delivery;
    });
    if (delivery && "unavailable" in delivery)
      throw new DeliveryError("email_unavailable");
    if (delivery) {
      // Final access/preference check, committed before any network I/O.
      const allowed = await scoped(
        pool,
        job,
        async (tx) =>
          (
            await tx.query(
              `SELECT m.id FROM app.memberships m JOIN app.users u ON u.id=m.user_id JOIN app.notification_preferences p ON p.org_id=m.org_id AND p.membership_id=m.id
    JOIN app.activity_events e ON e.org_id=m.org_id AND e.id=$3 JOIN app.issues i ON i.org_id=e.org_id AND i.id=e.issue_id JOIN app.projects pr ON pr.org_id=i.org_id AND pr.id=i.project_id
    WHERE m.org_id=$1 AND m.id=$2 AND m.state='active' AND u.disabled_at IS NULL AND p.assignment_email AND u.verified_email=$4 AND u.email_verified_at>now()-interval '24 hours' AND i.assignee_membership_id=m.id AND pr.archived_at IS NULL`,
              [
                job.org_id,
                delivery.recipientId,
                delivery.eventId,
                delivery.request.to[0],
              ],
            )
          ).rowCount,
      );
      if (allowed) {
        if (!options.sendEmail) throw new DeliveryError("email_unavailable");
        const budget = await pool.query(
          "SELECT app.reserve_email($1,$2,$3) AS reserved",
          [job.id, job.lease_token, options.emailDailyLimit ?? 100],
        );
        if (!budget.rows[0].reserved) throw new DeliveryError("email_budget");
        await options.sendEmail(
          delivery.request,
          `assignment/${delivery.eventId}/${delivery.recipientId}`,
        );
        await scoped(pool, job, (tx) =>
          tx.query(
            "UPDATE app.email_deliveries SET sent_at=now() WHERE org_id=$1 AND event_id=$2 AND recipient_membership_id=$3",
            [job.org_id, delivery.eventId, delivery.recipientId],
          ),
        );
      }
    }
    return await finishJob(pool, job);
  } catch (error) {
    const code =
      error instanceof DeliveryError
        ? error.code
        : error instanceof Error && error.message === "unsupported_job"
          ? "unsupported_job"
          : "processing_failed";
    await finishJob(pool, job, code);
    return false;
  }
}
