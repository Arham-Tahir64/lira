import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import {
  AttachmentInput,
  AttachmentParams,
  IssueParams,
  Uuid,
} from "@lira/contracts";
import { withTenant, type Transaction } from "./database.js";
import { projectAccess } from "./work.js";
import { Problem } from "./problem.js";
import {
  MAX_FILE_BYTES,
  WORKSPACE_BYTES,
  type AttachmentOptions,
} from "./storage.js";
export async function attachmentEvent(
  tx: Transaction,
  orgId: string,
  projectId: string,
  issueId: string,
  actor: string,
  id: string,
  action: string,
  runAt = new Date(),
) {
  const event = (
    await tx.query(
      "INSERT INTO app.activity_events(org_id,project_id,issue_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [
        orgId,
        projectId,
        issueId,
        actor,
        action === "attachment.cleanup" ? "attachment.reserved" : action,
        JSON.stringify({ attachmentId: id }),
      ],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO app.outbox_jobs(org_id,event_id,type,payload,run_at) VALUES($1,$2,$3,$4,$5)",
    [orgId, event.id, action, JSON.stringify({ attachmentId: id }), runAt],
  );
}
async function usage(tx: Transaction, orgId: string) {
  return (
    await tx.query(
      "SELECT COALESCE(sum(charged_bytes),0)::bigint AS bytes,count(*)::int AS count FROM app.attachments WHERE org_id=$1 AND state<>'deleted'",
      [orgId],
    )
  ).rows[0];
}
const fields =
  "id,name,media_type,bytes,state,uploader_membership_id,created_at,rejection";
export async function attachmentRoutes(
  api: FastifyInstance,
  pool: pg.Pool,
  options?: AttachmentOptions,
) {
  const security = [{ bearerAuth: [] }];
  const Query = Type.Object(
    { after: Type.Optional(Uuid) },
    { additionalProperties: false },
  );
  const enabled = (orgId: string) => !!options?.pilotOrgs.has(orgId);
  function storage() {
    if (!options)
      throw new Problem(
        503,
        "storage_unavailable",
        "File storage is not configured.",
      );
    return options.storage;
  }
  api.get<{
    Params: Static<typeof IssueParams>;
    Querystring: Static<typeof Query>;
  }>(
    "/orgs/:orgId/issues/:issueId/attachments",
    { schema: { params: IssueParams, querystring: Query, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx) => {
        const issue = (
          await tx.query(
            "SELECT project_id FROM app.issues WHERE org_id=$1 AND id=$2",
            [r.params.orgId, r.params.issueId],
          )
        ).rows[0];
        if (!issue) throw new Problem(404, "not_found", "Task not found.");
        const rows = (
          await tx.query(
            `SELECT ${fields} FROM app.attachments WHERE org_id=$1 AND issue_id=$2 AND state<>'deleted' AND ($3::uuid IS NULL OR (created_at,id)>(SELECT created_at,id FROM app.attachments WHERE org_id=$1 AND issue_id=$2 AND id=$3)) ORDER BY created_at,id LIMIT 31`,
            [r.params.orgId, r.params.issueId, r.query.after ?? null],
          )
        ).rows;
        const totals = await usage(tx, r.params.orgId);
        return {
          items: rows.slice(0, 30),
          nextCursor: rows.length > 30 ? rows[29].id : null,
          uploadEnabled: enabled(r.params.orgId),
          usedBytes: Number(totals.bytes),
          quotaBytes: WORKSPACE_BYTES,
          maxFileBytes: MAX_FILE_BYTES,
        };
      }),
  );
  api.post<{
    Params: Static<typeof IssueParams>;
    Body: Static<typeof AttachmentInput>;
  }>(
    "/orgs/:orgId/issues/:issueId/attachments",
    {
      schema: { params: IssueParams, body: AttachmentInput, security },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      const result = await withTenant(
        pool,
        r.identity,
        r.params.orgId,
        async (tx, member) => {
          const extensions: Record<string, string[]> = {
            "application/pdf": ["pdf"],
            "image/png": ["png"],
            "image/jpeg": ["jpg", "jpeg"],
            "text/plain": ["txt"],
          };
          if (
            !extensions[r.body.mediaType]?.includes(
              r.body.name.split(".").pop()?.toLowerCase() ?? "",
            )
          )
            throw new Problem(
              400,
              "invalid_filename",
              "Choose a filename ending in .pdf, .png, .jpg, .jpeg, or .txt that matches the file type.",
            );
          if (!enabled(r.params.orgId))
            throw new Problem(
              403,
              "uploads_disabled",
              "Uploads are not enabled for this workspace.",
            );
          const issue = (
            await tx.query(
              "SELECT project_id FROM app.issues WHERE org_id=$1 AND id=$2",
              [r.params.orgId, r.params.issueId],
            )
          ).rows[0];
          if (!issue) throw new Problem(404, "not_found", "Task not found.");
          await projectAccess(tx, r.params.orgId, issue.project_id, true);
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,2))",
            [r.params.orgId],
          );
          let row = (
            await tx.query(
              "SELECT * FROM app.attachments WHERE org_id=$1 AND uploader_membership_id=$2 AND client_key=$3",
              [r.params.orgId, member.id, r.body.clientKey],
            )
          ).rows[0];
          if (row) {
            if (
              row.issue_id !== r.params.issueId ||
              row.name !== r.body.name ||
              row.media_type !== r.body.mediaType ||
              row.bytes !== r.body.bytes ||
              row.checksum !== r.body.checksum
            )
              throw new Problem(
                409,
                "retry_conflict",
                "This upload request was already used for a different file.",
              );
            if (
              row.state !== "pending" ||
              new Date(row.expires_at).getTime() <= Date.now()
            )
              throw new Problem(
                409,
                "upload_expired",
                "This upload is already submitted or expired. Refresh attachments.",
              );
          } else {
            const totals = await usage(tx, r.params.orgId);
            const count = (
              await tx.query(
                "SELECT count(*)::int AS count FROM app.attachments WHERE org_id=$1 AND issue_id=$2 AND state<>'deleted'",
                [r.params.orgId, r.params.issueId],
              )
            ).rows[0].count;
            if (
              Number(totals.bytes) + MAX_FILE_BYTES > WORKSPACE_BYTES ||
              totals.count >= 500 ||
              count >= 50
            )
              throw new Problem(
                409,
                "storage_quota",
                "Workspace storage or attachment count limit reached. Remove files and wait for cleanup before retrying.",
              );
            const id = randomUUID();
            row = (
              await tx.query(
                "INSERT INTO app.attachments(id,org_id,project_id,issue_id,uploader_membership_id,client_key,object_key,name,media_type,bytes,checksum) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *",
                [
                  id,
                  r.params.orgId,
                  issue.project_id,
                  r.params.issueId,
                  member.id,
                  r.body.clientKey,
                  `${r.params.orgId}/${issue.project_id}/${id}`,
                  r.body.name,
                  r.body.mediaType,
                  r.body.bytes,
                  r.body.checksum,
                ],
              )
            ).rows[0];
            await attachmentEvent(
              tx,
              r.params.orgId,
              issue.project_id,
              r.params.issueId,
              member.id,
              id,
              "attachment.cleanup",
              row.delete_after,
            );
          }
          // Hold the authorization lock while minting this capability. Never persist or log the URL.
          const uploadUrl = await storage().signUpload(row.object_key);
          return { id: row.id, uploadUrl, expiresAt: row.expires_at };
        },
      );
      return reply.code(201).send(result);
    },
  );
  for (const action of ["complete", "download", "delete"] as const) {
    api.route<{ Params: Static<typeof AttachmentParams> }>({
      method: action === "delete" ? "DELETE" : "POST",
      url: `/orgs/:orgId/attachments/:attachmentId${action === "delete" ? "" : `/${action}`}`,
      schema: { params: AttachmentParams, security },
      handler: async (r, reply) => {
        const result = await withTenant(
          pool,
          r.identity,
          r.params.orgId,
          async (tx, member) => {
            const row = (
              await tx.query(
                "SELECT * FROM app.attachments WHERE org_id=$1 AND id=$2 FOR UPDATE",
                [r.params.orgId, r.params.attachmentId],
              )
            ).rows[0];
            if (!row)
              throw new Problem(404, "not_found", "Attachment not found.");
            await projectAccess(
              tx,
              r.params.orgId,
              row.project_id,
              action !== "download",
            );
            if (action === "download") {
              if (row.state !== "ready")
                throw new Problem(
                  409,
                  "file_not_ready",
                  "This file is not available for download.",
                );
              return {
                url: await storage().signDownload(row.object_key, row.name),
              };
            }
            if (
              row.uploader_membership_id !== member.id &&
              (action === "complete" || member.role === "member")
            )
              throw new Problem(
                403,
                "forbidden",
                "Only the uploader can finish an upload. Uploaders and administrators can remove files.",
              );
            if (action === "complete") {
              if (!enabled(r.params.orgId))
                throw new Problem(
                  403,
                  "uploads_disabled",
                  "Uploads are disabled for this workspace.",
                );
              if (["quarantined", "ready"].includes(row.state))
                return { state: row.state };
              if (
                row.state !== "pending" ||
                new Date(row.expires_at).getTime() <= Date.now()
              )
                throw new Problem(
                  409,
                  "upload_expired",
                  "This upload expired. Remove it and upload again.",
                );
              await tx.query(
                "UPDATE app.attachments SET state='quarantined' WHERE org_id=$1 AND id=$2",
                [r.params.orgId, row.id],
              );
              await attachmentEvent(
                tx,
                r.params.orgId,
                row.project_id,
                row.issue_id,
                member.id,
                row.id,
                "attachment.validate",
              );
              return { state: "quarantined" };
            }
            if (!["deleting", "deleted"].includes(row.state)) {
              await tx.query(
                "UPDATE app.attachments SET state='deleting' WHERE org_id=$1 AND id=$2",
                [r.params.orgId, row.id],
              );
              await attachmentEvent(
                tx,
                r.params.orgId,
                row.project_id,
                row.issue_id,
                member.id,
                row.id,
                "attachment.remove",
                new Date(
                  Math.max(Date.now(), new Date(row.delete_after).getTime()),
                ),
              );
            }
            return undefined;
          },
        );
        return action === "delete" ? reply.code(204).send() : result;
      },
    });
  }
}
