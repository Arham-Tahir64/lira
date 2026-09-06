import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { Type, type Static } from "@sinclair/typebox";
import { OrgParams, Uuid } from "@lira/contracts";
import { withTenant } from "./database.js";
import { Problem } from "./problem.js";
import { requireAdmin } from "./policy.js";
export async function notificationRoutes(
  api: FastifyInstance,
  pool: pg.Pool,
  emailEnabled = false,
) {
  const security = [{ bearerAuth: [] }];
  const Query = Type.Object(
    {
      after: Type.Optional(Uuid),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      unread: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  );
  api.get<{
    Params: Static<typeof OrgParams>;
    Querystring: Static<typeof Query>;
  }>(
    "/orgs/:orgId/notifications",
    { schema: { params: OrgParams, querystring: Query, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        const limit = r.query.limit ?? 30;
        const { rows } = await tx.query(
          `SELECT n.id,n.project_id,n.issue_id,n.type,n.created_at,n.read_at,i.title,i.number,p.key AS project_key FROM app.notifications n JOIN app.issues i ON i.org_id=n.org_id AND i.id=n.issue_id JOIN app.projects p ON p.org_id=n.org_id AND p.id=n.project_id
    WHERE n.org_id=$1 AND n.recipient_membership_id=$2 AND (NOT $3::boolean OR n.read_at IS NULL) AND ($4::uuid IS NULL OR (n.created_at,n.id)<(SELECT created_at,id FROM app.notifications WHERE org_id=$1 AND recipient_membership_id=$2 AND id=$4)) ORDER BY n.created_at DESC,n.id DESC LIMIT $5`,
          [
            r.params.orgId,
            member.id,
            r.query.unread ?? false,
            r.query.after ?? null,
            limit + 1,
          ],
        );
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1].id : null,
        };
      }),
  );
  const Params = Type.Object(
    { orgId: Uuid, notificationId: Uuid },
    { additionalProperties: false },
  );
  const Read = Type.Object(
    { read: Type.Boolean() },
    { additionalProperties: false },
  );
  api.patch<{ Params: Static<typeof Params>; Body: Static<typeof Read> }>(
    "/orgs/:orgId/notifications/:notificationId",
    { schema: { params: Params, body: Read, security } },
    async (r, reply) => {
      await withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        const result = await tx.query(
          "UPDATE app.notifications SET read_at=CASE WHEN $4 THEN COALESCE(read_at,now()) ELSE NULL END WHERE org_id=$1 AND id=$2 AND recipient_membership_id=$3 RETURNING id",
          [r.params.orgId, r.params.notificationId, member.id, r.body.read],
        );
        if (!result.rowCount)
          throw new Problem(404, "not_found", "Notification not found.");
      });
      return reply.code(204).send();
    },
  );
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/notification-preferences",
    { schema: { params: OrgParams, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => ({
        assignmentEmail:
          (
            await tx.query(
              "SELECT assignment_email FROM app.notification_preferences WHERE org_id=$1 AND membership_id=$2",
              [r.params.orgId, member.id],
            )
          ).rows[0]?.assignment_email ?? false,
        emailAvailable: emailEnabled,
      })),
  );
  const Preference = Type.Object(
    { assignmentEmail: Type.Boolean() },
    { additionalProperties: false },
  );
  api.put<{
    Params: Static<typeof OrgParams>;
    Body: Static<typeof Preference>;
  }>(
    "/orgs/:orgId/notification-preferences",
    { schema: { params: OrgParams, body: Preference, security } },
    async (r, reply) => {
      if (r.body.assignmentEmail && !emailEnabled)
        throw new Problem(
          409,
          "email_unavailable",
          "Assignment email is not available yet.",
        );
      await withTenant(pool, r.identity, r.params.orgId, async (tx, member) =>
        tx.query(
          "INSERT INTO app.notification_preferences(org_id,membership_id,assignment_email) VALUES($1,$2,$3) ON CONFLICT(org_id,membership_id) DO UPDATE SET assignment_email=excluded.assignment_email",
          [r.params.orgId, member.id, r.body.assignmentEmail],
        ),
      );
      return reply.code(204).send();
    },
  );
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/jobs/status",
    { schema: { params: OrgParams, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        requireAdmin(member);
        return {
          counts: (
            await tx.query(
              "SELECT state,count(*)::int AS count FROM app.outbox_jobs WHERE org_id=$1 GROUP BY state",
              [r.params.orgId],
            )
          ).rows,
          failed: (
            await tx.query(
              "SELECT id,type,attempts,last_error,created_at FROM app.outbox_jobs WHERE org_id=$1 AND state='failed' ORDER BY created_at DESC,id DESC LIMIT 30",
              [r.params.orgId],
            )
          ).rows,
        };
      }),
  );
}
