import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { Type, type Static } from "@sinclair/typebox";
import { OrgParams, Uuid } from "@lira/contracts";
import { withTenant } from "./database.js";
import { templates } from "./templates.js";
export async function dashboardRoutes(api: FastifyInstance, pool: pg.Pool) {
  const security = [{ bearerAuth: [] }];
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/templates",
    { schema: { params: OrgParams, security } },
    (r) => withTenant(pool, r.identity, r.params.orgId, async () => templates),
  );
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/dashboard",
    { schema: { params: OrgParams, security } },
    (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        const today = (
          await tx.query(
            "SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS today FROM app.organizations WHERE id=$1",
            [r.params.orgId],
          )
        ).rows[0].today;
        const counts = (
          await tx.query(
            `SELECT count(*) FILTER(WHERE i.status='todo')::int AS todo,count(*) FILTER(WHERE i.status='in_progress')::int AS in_progress,count(*) FILTER(WHERE i.status='done')::int AS done,count(*) FILTER(WHERE i.status<>'done' AND i.due_date<$3::date)::int AS overdue,count(*) FILTER(WHERE i.status<>'done' AND i.assignee_membership_id=$2)::int AS assigned,count(*) FILTER(WHERE i.planning_state='backlog')::int AS backlog FROM app.issues i JOIN app.projects p ON p.org_id=i.org_id AND p.id=i.project_id WHERE i.org_id=$1 AND p.archived_at IS NULL`,
            [r.params.orgId, member.id, today],
          )
        ).rows[0];
        const projects = (
          await tx.query(
            `SELECT p.id,p.name,p.key,p.term,count(i.id)::int AS total,count(i.id) FILTER(WHERE i.status='done')::int AS done,count(i.id) FILTER(WHERE i.status<>'done' AND i.due_date<$2::date)::int AS overdue FROM app.projects p LEFT JOIN app.issues i ON i.org_id=p.org_id AND i.project_id=p.id WHERE p.org_id=$1 AND p.archived_at IS NULL GROUP BY p.id ORDER BY p.created_at,p.id LIMIT 100`,
            [r.params.orgId, today],
          )
        ).rows;
        return { today, counts, projects };
      }),
  );
  const Query = Type.Object(
    {
      kind: Type.Union([Type.Literal("mine"), Type.Literal("overdue")]),
      after: Type.Optional(Uuid),
    },
    { additionalProperties: false },
  );
  api.get<{
    Params: Static<typeof OrgParams>;
    Querystring: Static<typeof Query>;
  }>(
    "/orgs/:orgId/dashboard/tasks",
    { schema: { params: OrgParams, querystring: Query, security } },
    (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        const rows = (
          await tx.query(
            `WITH visible AS (SELECT i.id,i.project_id,i.number,i.title,i.status,i.priority,i.planning_state,i.due_date,p.key AS project_key,p.name AS project_name FROM app.issues i JOIN app.projects p ON p.org_id=i.org_id AND p.id=i.project_id JOIN app.organizations o ON o.id=i.org_id WHERE i.org_id=$1 AND p.archived_at IS NULL AND i.status<>'done' AND (($3='mine' AND i.assignee_membership_id=$2) OR ($3='overdue' AND i.due_date<(now() AT TIME ZONE o.timezone)::date))) SELECT id,project_id,number,title,status,priority,planning_state,to_char(due_date,'YYYY-MM-DD') AS due_date,project_key,project_name FROM visible WHERE $4::uuid IS NULL OR (COALESCE(due_date,'9999-12-31'::date),id)>(SELECT COALESCE(due_date,'9999-12-31'::date),id FROM visible WHERE id=$4) ORDER BY COALESCE(due_date,'9999-12-31'::date),id LIMIT 21`,
            [r.params.orgId, member.id, r.query.kind, r.query.after ?? null],
          )
        ).rows;
        return {
          items: rows.slice(0, 20),
          nextCursor: rows.length > 20 ? rows[19].id : null,
        };
      }),
  );
}
