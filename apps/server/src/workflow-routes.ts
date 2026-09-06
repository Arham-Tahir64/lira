import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { Type, type Static } from "@sinclair/typebox";
import {
  OrgParams,
  ProjectParams,
  IssueParams,
  LabelInput,
  MoveInput,
  Uuid,
} from "@lira/contracts";
import { withTenant } from "./database.js";
import { projectAccess, updateIssue } from "./work.js";
import { Problem } from "./problem.js";
export async function workflowRoutes(api: FastifyInstance, pool: pg.Pool) {
  const security = [{ bearerAuth: [] }];
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/labels",
    { schema: { params: OrgParams, security } },
    async (r) =>
      withTenant(
        pool,
        r.identity,
        r.params.orgId,
        async (tx) =>
          (
            await tx.query(
              "SELECT id,name,color FROM app.labels WHERE org_id=$1 ORDER BY lower(name),id LIMIT 200",
              [r.params.orgId],
            )
          ).rows,
      ),
  );
  api.post<{
    Params: Static<typeof OrgParams>;
    Body: Static<typeof LabelInput>;
  }>(
    "/orgs/:orgId/labels",
    { schema: { params: OrgParams, body: LabelInput, security } },
    async (r, reply) => {
      const result = await withTenant(
        pool,
        r.identity,
        r.params.orgId,
        async (tx) => {
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`labels:${r.params.orgId}`],
          );
          const count = await tx.query(
            "SELECT count(*)::int AS count FROM app.labels WHERE org_id=$1",
            [r.params.orgId],
          );
          if (count.rows[0].count >= 200)
            throw new Problem(
              429,
              "label_limit",
              "The workspace limit is 200 labels.",
            );
          return (
            await tx.query(
              "INSERT INTO app.labels(org_id,name) VALUES($1,$2) RETURNING id,name,color",
              [r.params.orgId, r.body.name.trim()],
            )
          ).rows[0];
        },
      );
      return reply.code(201).send(result);
    },
  );
  api.get<{ Params: Static<typeof IssueParams> }>(
    "/orgs/:orgId/issues/:issueId/labels",
    { schema: { params: IssueParams, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx) => {
        const issue = await tx.query(
          "SELECT id FROM app.issues WHERE org_id=$1 AND id=$2",
          [r.params.orgId, r.params.issueId],
        );
        if (!issue.rowCount)
          throw new Problem(404, "not_found", "Task not found.");
        return (
          await tx.query(
            "SELECT l.id,l.name,l.color FROM app.labels l JOIN app.issue_labels il ON il.org_id=l.org_id AND il.label_id=l.id WHERE il.org_id=$1 AND il.issue_id=$2 ORDER BY l.name",
            [r.params.orgId, r.params.issueId],
          )
        ).rows;
      }),
  );
  const ActivityQuery = Type.Object(
    {
      after: Type.Optional(Uuid),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  );
  api.get<{
    Params: Static<typeof ProjectParams>;
    Querystring: Static<typeof ActivityQuery>;
  }>(
    "/orgs/:orgId/projects/:projectId/activity",
    { schema: { params: ProjectParams, querystring: ActivityQuery, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx) => {
        await projectAccess(tx, r.params.orgId, r.params.projectId);
        const limit = r.query.limit ?? 30;
        const result = await tx.query(
          "SELECT e.id,e.action,e.changes,e.created_at,m.display_name AS actor_name,i.number AS issue_number FROM app.activity_events e JOIN app.memberships m ON m.org_id=e.org_id AND m.id=e.actor_membership_id LEFT JOIN app.issues i ON i.org_id=e.org_id AND i.id=e.issue_id WHERE e.org_id=$1 AND e.project_id=$2 AND ($3::uuid IS NULL OR (e.created_at,e.id)<(SELECT created_at,id FROM app.activity_events WHERE org_id=$1 AND project_id=$2 AND id=$3)) ORDER BY e.created_at DESC,e.id DESC LIMIT $4",
          [
            r.params.orgId,
            r.params.projectId,
            r.query.after ?? null,
            limit + 1,
          ],
        );
        return {
          items: result.rows.slice(0, limit),
          nextCursor:
            result.rows.length > limit ? result.rows[limit - 1].id : null,
        };
      }),
  );
  for (const action of ["archive", "unarchive"] as const) {
    api.post<{ Params: Static<typeof ProjectParams> }>(
      `/orgs/:orgId/projects/:projectId/${action}`,
      { schema: { params: ProjectParams, security } },
      async (r) =>
        withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
          const result = await tx.query(
            "SELECT lead_membership_id,archived_at FROM app.projects WHERE org_id=$1 AND id=$2 FOR UPDATE",
            [r.params.orgId, r.params.projectId],
          );
          const project = result.rows[0];
          if (!project)
            throw new Problem(404, "not_found", "Project not found.");
          if (
            member.role === "member" &&
            project.lead_membership_id !== member.id
          )
            throw new Problem(
              403,
              "forbidden",
              "Only a project lead or workspace administrator can archive projects.",
            );
          const archived = action === "archive";
          if (Boolean(project.archived_at) !== archived) {
            await tx.query(
              `UPDATE app.projects SET archived_at=${archived ? "now()" : "NULL"} WHERE org_id=$1 AND id=$2`,
              [r.params.orgId, r.params.projectId],
            );
            await tx.query(
              "INSERT INTO app.activity_events(org_id,project_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4,'{}')",
              [
                r.params.orgId,
                r.params.projectId,
                member.id,
                `project.${action}`,
              ],
            );
          }
          return { archived };
        }),
    );
  }
  api.post<{
    Params: Static<typeof IssueParams>;
    Body: Static<typeof MoveInput>;
  }>(
    "/orgs/:orgId/issues/:issueId/move",
    { schema: { params: IssueParams, body: MoveInput, security } },
    async (r) =>
      withTenant(pool, r.identity, r.params.orgId, async (tx, member) => {
        const { orgId, issueId } = r.params;
        const issue = (
          await tx.query(
            "SELECT project_id FROM app.issues WHERE org_id=$1 AND id=$2",
            [orgId, issueId],
          )
        ).rows[0];
        if (!issue) throw new Problem(404, "not_found", "Task not found.");
        // All rank calculations and rebalancing serialize on this project, including creates.
        await tx.query(
          "SELECT id FROM app.projects WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [orgId, issue.project_id],
        );
        await projectAccess(tx, orgId, issue.project_id, true);
        const { status, planningState, beforeId, expectedVersion } = r.body;
        if (status === "done" && planningState === "backlog")
          throw new Problem(
            409,
            "invalid_planning_state",
            "Completed work cannot be in the backlog.",
          );
        if (beforeId === issueId)
          throw new Problem(
            400,
            "invalid_neighbor",
            "Choose a different task as the destination.",
          );
        if (beforeId) {
          const neighbor = await tx.query(
            "SELECT id FROM app.issues WHERE org_id=$1 AND project_id=$2 AND id=$3 AND status=$4 AND planning_state=$5",
            [orgId, issue.project_id, beforeId, status, planningState],
          );
          if (!neighbor.rowCount)
            throw new Problem(
              409,
              "invalid_neighbor",
              "The destination changed. Refresh the board.",
            );
        }
        // Rebalance only when a gap becomes too small. Numeric SQL arithmetic avoids floating point loss.
        const rankQuery = `SELECT CASE WHEN $3::uuid IS NULL THEN COALESCE(max(rank),0)+1024 ELSE ((SELECT rank FROM app.issues WHERE org_id=$1 AND id=$3)+COALESCE(max(rank) FILTER(WHERE (rank,id)<(SELECT rank,id FROM app.issues WHERE org_id=$1 AND id=$3)),0))/2 END AS rank FROM app.issues WHERE org_id=$1 AND project_id=$2 AND id<>$4 AND status=$5 AND planning_state=$6`;
        const args = [
          orgId,
          issue.project_id,
          beforeId,
          issueId,
          status,
          planningState,
        ];
        let rank = (await tx.query(rankQuery, args)).rows[0].rank;
        const gap = await tx.query(
          "SELECT 1 FROM app.issues WHERE org_id=$1 AND project_id=$2 AND id<>$3 AND status=$4 AND planning_state=$5 AND abs(rank-$6::numeric)<0.000001 LIMIT 1",
          [orgId, issue.project_id, issueId, status, planningState, rank],
        );
        if (gap.rowCount) {
          await tx.query(
            "WITH ranks AS (SELECT id,row_number() OVER(ORDER BY rank,id)*1024 AS value FROM app.issues WHERE org_id=$1 AND project_id=$2 AND status=$3 AND planning_state=$4) UPDATE app.issues i SET rank=r.value FROM ranks r WHERE i.org_id=$1 AND i.id=r.id",
            [orgId, issue.project_id, status, planningState],
          );
          rank = (await tx.query(rankQuery, args)).rows[0].rank;
        }
        const updated = await updateIssue(
          tx,
          orgId,
          issueId,
          member,
          { status, planningState },
          expectedVersion,
        );
        await tx.query(
          "UPDATE app.issues SET rank=$3 WHERE org_id=$1 AND id=$2",
          [orgId, issueId, rank],
        );
        await tx.query(
          "INSERT INTO app.activity_events(org_id,project_id,issue_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4,'issue.moved',$5)",
          [
            orgId,
            issue.project_id,
            issueId,
            member.id,
            JSON.stringify({ beforeId, status, planningState }),
          ],
        );
        return updated;
      }),
  );
}
