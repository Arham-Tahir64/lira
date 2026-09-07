import type pg from "pg";
import { validFile, type AttachmentOptions } from "./storage.js";
type Scoped = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => Promise<T>;
/** Provider I/O stays outside SQL transactions. Every state write rechecks the job lease. */
export async function processAttachment(
  orgId: string,
  jobId: string,
  scope: Scoped,
  options?: AttachmentOptions,
) {
  if (!options) throw new Error("storage_unavailable");
  const work = await scope(async (tx) => {
    const job = (
      await tx.query(
        "SELECT type,payload FROM app.outbox_jobs WHERE org_id=$1 AND id=$2",
        [orgId, jobId],
      )
    ).rows[0];
    if (
      ![
        "attachment.validate",
        "attachment.cleanup",
        "attachment.remove",
      ].includes(job.type)
    )
      throw new Error("unsupported_job");
    const row = (
      await tx.query(
        "SELECT * FROM app.attachments WHERE org_id=$1 AND id=$2 FOR UPDATE",
        [orgId, job.payload.attachmentId],
      )
    ).rows[0];
    if (!row) throw new Error("missing_attachment");
    if (job.type === "attachment.validate")
      return row.state === "quarantined" ? { row, validate: true } : null;
    if (
      row.state === "deleted" ||
      (row.state === "ready" && job.type === "attachment.cleanup")
    )
      return null;
    // Upload capabilities can be replayed after removal. Never remove bytes before all can expire.
    if (new Date(row.delete_after).getTime() > Date.now())
      throw new Error("cleanup_too_early");
    await tx.query(
      "UPDATE app.attachments SET state='deleting' WHERE org_id=$1 AND id=$2",
      [orgId, row.id],
    );
    return { row, validate: false };
  });
  if (!work) return;
  const { row } = work;
  if (work.validate) {
    if (!options.pilotOrgs.has(orgId)) throw new Error("uploads_disabled");
    let valid = false;
    try {
      const bytes = await options.storage.read(row.object_key);
      valid = validFile(bytes, row.media_type, row.bytes, row.checksum);
    } catch (error) {
      if (!(error instanceof Error && error.message === "oversized_object"))
        throw error;
    }
    await scope(async (tx) => {
      // Recheck uploader and project after I/O, including offboarding while validation ran.
      const access = (
        await tx.query(
          "SELECT m.id FROM app.memberships m JOIN app.projects p ON p.org_id=m.org_id AND p.id=$3 JOIN app.users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.id=$2 AND m.state='active' AND u.disabled_at IS NULL AND p.archived_at IS NULL",
          [orgId, row.uploader_membership_id, row.project_id],
        )
      ).rowCount;
      await tx.query(
        "UPDATE app.attachments SET state=$3,rejection=$4,charged_bytes=CASE WHEN $3='ready' THEN bytes ELSE charged_bytes END WHERE org_id=$1 AND id=$2 AND state='quarantined'",
        [
          orgId,
          row.id,
          valid && access ? "ready" : "deleting",
          valid && access
            ? null
            : "File validation failed or uploader access changed.",
        ],
      );
    });
  } else {
    await options.storage.remove(row.object_key);
    await scope((tx) =>
      tx.query(
        "UPDATE app.attachments SET state='deleted',rejection=NULL WHERE org_id=$1 AND id=$2 AND state='deleting'",
        [orgId, row.id],
      ),
    );
  }
}
