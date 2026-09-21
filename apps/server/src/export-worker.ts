import type pg from "pg";
import { createHash } from "node:crypto";
import type { ExportStorage } from "./export-storage.js";
type Scope = <T>(fn: (tx: pg.PoolClient) => Promise<T>) => Promise<T>;
// Explicit portable data fields; never export auth subjects, contact emails, tokens, signed URLs, or worker internals.
const datasets = [
  ["organizations", "id,slug,name,timezone,created_at", "id"],
  ["memberships", "id,display_name,role,state,created_at,left_at", "id"],
  ["teams", "id,name,created_at", "id"],
  ["team_members", "team_id,membership_id", "team_id,membership_id"],
  [
    "projects",
    "id,name,key,description,lead_membership_id,term,template_id,archived_at,created_at",
    "id",
  ],
  ["boards", "id,project_id,name", "id"],
  [
    "issues",
    "id,project_id,number,title,description,status,priority,planning_state,assignee_membership_id,creator_membership_id,due_date,rank,version,created_at,updated_at",
    "id",
  ],
  ["labels", "id,name,color", "id"],
  ["issue_labels", "issue_id,label_id", "issue_id,label_id"],
  [
    "comments",
    "id,project_id,issue_id,author_membership_id,CASE WHEN deleted_at IS NULL THEN body ELSE '' END AS body,version,created_at,edited_at,deleted_at",
    "id",
  ],
  [
    "attachments",
    "id,project_id,issue_id,uploader_membership_id,name,media_type,bytes,checksum,state,object_key,created_at",
    "id",
  ],
  [
    "activity_events",
    "id,project_id,issue_id,actor_membership_id,action,changes,created_at",
    "id",
  ],
] as const;
async function administrator(tx: pg.PoolClient, org: string, id: string) {
  return !!(
    await tx.query(
      "SELECT m.id FROM app.memberships m JOIN app.users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.id=$2 AND m.state='active' AND m.role IN ('owner','admin') AND u.disabled_at IS NULL",
      [org, id],
    )
  ).rowCount;
}
export async function processExport(
  org: string,
  jobId: string,
  scope: Scope,
  snapshotScope: Scope,
  storage?: ExportStorage,
) {
  if (!storage) throw new Error("exports_unavailable");
  const work = await scope(async (tx) => {
    const job = (
      await tx.query(
        "SELECT type,payload FROM app.outbox_jobs WHERE org_id=$1 AND id=$2",
        [org, jobId],
      )
    ).rows[0];
    if (!["export.generate", "export.cleanup"].includes(job.type))
      throw new Error("unsupported_job");
    const row = (
      await tx.query("SELECT * FROM app.exports WHERE org_id=$1 AND id=$2", [
        org,
        job.payload.exportId,
      ])
    ).rows[0];
    if (!row) throw new Error("missing_export");
    return { row, cleanup: job.type === "export.cleanup" };
  });
  const { row } = work;
  if (work.cleanup) {
    if (new Date(row.expires_at).getTime() + 3600000 > Date.now())
      throw new Error("cleanup_too_early");
    await storage.remove(row.object_key);
    await scope((tx) =>
      tx.query(
        "UPDATE app.exports SET state='expired',checksum=NULL,bytes=NULL WHERE org_id=$1 AND id=$2",
        [org, row.id],
      ),
    );
    return;
  }
  if (row.state !== "pending") return;
  if (new Date(row.expires_at).getTime() <= Date.now()) return;
  try {
    const document = await snapshotScope(async (tx) => {
      if (!(await administrator(tx, org, row.requester_membership_id)))
        throw new Error("export_access_lost");
      const snapshotAt = (
        await tx.query("SELECT transaction_timestamp() AS snapshot")
      ).rows[0].snapshot.toISOString();
      const result: Record<string, unknown> = {
        format: "lira-export",
        version: 1,
        organizationId: org,
        exportId: row.id,
        snapshotAt,
        attachmentFilesIncluded: false,
      };
      let total = 1024;
      const deadline = Date.now() + 20000;
      for (const [table, fields, order] of datasets) {
        const records: unknown[] = [];
        for (let offset = 0; ; offset += 100) {
          if (Date.now() > deadline) throw new Error("export_too_large");
          const items = (
            await tx.query(
              `SELECT ${fields} FROM app.${table} WHERE ${table === "organizations" ? "id" : "org_id"}=$1 ORDER BY ${order} LIMIT 100 OFFSET $2`,
              [org, offset],
            )
          ).rows;
          total += Buffer.byteLength(JSON.stringify(items));
          if (total > 5 * 1024 * 1024 || offset + items.length > 20000)
            throw new Error("export_too_large");
          records.push(...items);
          if (items.length < 100) break;
        }
        result[table === "attachments" ? "attachmentManifest" : table] =
          records;
      }
      return result;
    });
    // Immutable first successful upload wins. Retries read that exact snapshot, not a regenerated timestamp.
    await storage.writeJson(row.object_key, document);
    const bytes = await storage.read(row.object_key);
    const saved = JSON.parse(bytes.toString()) as {
      format?: string;
      exportId?: string;
      organizationId?: string;
      snapshotAt?: string;
    };
    if (
      bytes.length > 5242880 ||
      saved.format !== "lira-export" ||
      saved.exportId !== row.id ||
      saved.organizationId !== org ||
      !saved.snapshotAt ||
      !Number.isFinite(Date.parse(saved.snapshotAt))
    )
      throw new Error("invalid_export");
    await scope(async (tx) => {
      if (!(await administrator(tx, org, row.requester_membership_id)))
        throw new Error("export_access_lost");
      await tx.query(
        "UPDATE app.exports SET state='ready',snapshot_at=$3,bytes=$4,checksum=$5 WHERE org_id=$1 AND id=$2 AND state='pending' AND expires_at>now()",
        [
          org,
          row.id,
          saved.snapshotAt,
          bytes.length,
          createHash("sha256").update(bytes).digest("hex"),
        ],
      );
    });
  } catch (error) {
    if (
      error instanceof Error &&
      ["export_too_large", "export_access_lost"].includes(error.message)
    ) {
      await scope((tx) =>
        tx.query(
          "UPDATE app.exports SET state='failed',failure=$3 WHERE org_id=$1 AND id=$2 AND state='pending'",
          [
            org,
            row.id,
            error.message === "export_too_large"
              ? "Export exceeds the pilot limit. Contact a maintainer for a complete export."
              : "Requester no longer has administrator access.",
          ],
        ),
      );
      return;
    }
    throw error;
  }
}
