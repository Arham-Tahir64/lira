import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { OrgParams, Uuid } from "@lira/contracts";
import { withTenant } from "./database.js";
import { requireAdmin } from "./policy.js";
import { Problem } from "./problem.js";
import type { ExportStorage } from "./export-storage.js";
export async function exportRoutes(
  api: FastifyInstance,
  pool: pg.Pool,
  storage?: ExportStorage,
) {
  const security = [{ bearerAuth: [] }];
  const Input = Type.Object(
    { clientKey: Uuid },
    { additionalProperties: false },
  );
  const Params = Type.Object(
    { orgId: Uuid, exportId: Uuid },
    { additionalProperties: false },
  );
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/exports",
    { schema: { params: OrgParams, security } },
    (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        requireAdmin(member);
        const rows = (
          await tx.query(
            "SELECT e.id,CASE WHEN e.expires_at<=now() THEN 'expired' WHEN e.state='pending' AND j.state='failed' THEN 'failed' ELSE e.state END AS state,e.created_at,e.expires_at,e.snapshot_at,e.bytes,COALESCE(e.failure,CASE WHEN j.state='failed' THEN 'Export processing failed. Contact a maintainer.' END) AS failure FROM app.exports e LEFT JOIN app.outbox_jobs j ON j.org_id=e.org_id AND j.type='export.generate' AND j.payload->>'exportId'=e.id::text WHERE e.org_id=$1 ORDER BY e.created_at DESC,e.id DESC LIMIT 10",
            [r.params.orgId],
          )
        ).rows;
        return { enabled: !!storage, items: rows };
      }),
  );
  api.post<{ Params: Static<typeof OrgParams>; Body: Static<typeof Input> }>(
    "/orgs/:orgId/exports",
    {
      schema: { params: OrgParams, body: Input, security },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      const result = await withTenant(
        pool,
        r.identity,
        r.params.orgId,
        async (tx, member) => {
          requireAdmin(member);
          if (!storage)
            throw new Problem(
              503,
              "exports_unavailable",
              "Export storage is not configured.",
            );
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,4))",
            [r.params.orgId],
          );
          const prior = (
            await tx.query(
              "SELECT id FROM app.exports WHERE org_id=$1 AND requester_membership_id=$2 AND client_key=$3",
              [r.params.orgId, member.id, r.body.clientKey],
            )
          ).rows[0];
          if (prior) return prior;
          const count = (
            await tx.query(
              "SELECT count(*)::int AS count FROM app.exports WHERE org_id=$1 AND created_at>now()-interval '24 hours'",
              [r.params.orgId],
            )
          ).rows[0].count;
          const retained = (
            await tx.query(
              "SELECT count(*)::int AS count FROM app.exports WHERE org_id=$1 AND state<>'expired'",
              [r.params.orgId],
            )
          ).rows[0].count;
          if (retained >= 4)
            throw new Problem(
              429,
              "export_cleanup_pending",
              "Previous exports are awaiting cleanup. Contact a maintainer before requesting more.",
            );
          if (count >= 2)
            throw new Problem(
              429,
              "export_limit",
              "This workspace can request two exports per 24 hours.",
            );
          const id = randomUUID();
          await tx.query(
            "INSERT INTO app.exports(id,org_id,requester_membership_id,client_key,object_key) VALUES($1,$2,$3,$4,$5)",
            [
              id,
              r.params.orgId,
              member.id,
              r.body.clientKey,
              `${r.params.orgId}/${id}/${randomUUID()}`,
            ],
          );
          for (const kind of ["export.generate", "export.cleanup"]) {
            const event = (
              await tx.query(
                "INSERT INTO app.activity_events(org_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4) RETURNING id",
                [
                  r.params.orgId,
                  member.id,
                  kind === "export.generate"
                    ? "export.requested"
                    : "export.expiry_scheduled",
                  JSON.stringify({ exportId: id }),
                ],
              )
            ).rows[0];
            await tx.query(
              "INSERT INTO app.outbox_jobs(org_id,event_id,type,payload,run_at) VALUES($1,$2,$3,$4,now()+CASE WHEN $3='export.cleanup' THEN interval '25 hours' ELSE interval '0 seconds' END)",
              [
                r.params.orgId,
                event.id,
                kind,
                JSON.stringify({ exportId: id }),
              ],
            );
          }
          return { id };
        },
      );
      return reply.code(202).send(result);
    },
  );
  api.post<{ Params: Static<typeof Params> }>(
    "/orgs/:orgId/exports/:exportId/download",
    { schema: { params: Params, security } },
    (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        requireAdmin(member);
        const row = (
          await tx.query(
            "SELECT object_key FROM app.exports WHERE org_id=$1 AND id=$2 AND state='ready' AND expires_at>now()",
            [r.params.orgId, r.params.exportId],
          )
        ).rows[0];
        if (!row)
          throw new Problem(
            404,
            "export_unavailable",
            "Export is unavailable or expired.",
          );
        if (!storage)
          throw new Problem(
            503,
            "exports_unavailable",
            "Export storage is not configured.",
          );
        return {
          url: await storage.signDownload(
            row.object_key,
            `lira-${r.params.orgId}-export.json`,
          ),
        };
      }),
  );
}
