import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { Type, type Static } from "@sinclair/typebox";
import {
  IssueParams,
  CommentParams,
  CommentInput,
  CommentPatch,
  Uuid,
} from "@lira/contracts";
import { withTenant } from "./database.js";
import { projectAccess } from "./work.js";
import { Problem } from "./problem.js";
const fields =
  "c.id,c.issue_id,c.author_membership_id,m.display_name AS author_name,CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END AS body,c.version,c.created_at,c.edited_at,c.deleted_at";
export async function commentRoutes(api: FastifyInstance, pool: pg.Pool) {
  const security = [{ bearerAuth: [] }];
  const Query = Type.Object(
    {
      after: Type.Optional(Uuid),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  );
  api.get<{
    Params: Static<typeof IssueParams>;
    Querystring: Static<typeof Query>;
  }>(
    "/orgs/:orgId/issues/:issueId/comments",
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
        const limit = r.query.limit ?? 30;
        const { rows } = await tx.query(
          `SELECT ${fields} FROM app.comments c JOIN app.memberships m ON m.org_id=c.org_id AND m.id=c.author_membership_id WHERE c.org_id=$1 AND c.issue_id=$2 AND ($3::uuid IS NULL OR (c.created_at,c.id)>(SELECT created_at,id FROM app.comments WHERE org_id=$1 AND issue_id=$2 AND id=$3)) ORDER BY c.created_at,c.id LIMIT $4`,
          [r.params.orgId, r.params.issueId, r.query.after ?? null, limit + 1],
        );
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1].id : null,
        };
      }),
  );
  api.post<{
    Params: Static<typeof IssueParams>;
    Body: Static<typeof CommentInput>;
  }>(
    "/orgs/:orgId/issues/:issueId/comments",
    { schema: { params: IssueParams, body: CommentInput, security } },
    async (r, reply) => {
      const result = await withTenant(
        pool,
        r.identity,
        r.params.orgId,
        async (tx, member) => {
          const issue = (
            await tx.query(
              "SELECT project_id FROM app.issues WHERE org_id=$1 AND id=$2",
              [r.params.orgId, r.params.issueId],
            )
          ).rows[0];
          if (!issue) throw new Problem(404, "not_found", "Task not found.");
          await projectAccess(tx, r.params.orgId, issue.project_id, true);
          await tx.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [`${r.params.orgId}:${member.id}:${r.body.clientKey}`],
          );
          const prior = (
            await tx.query(
              "SELECT id,issue_id,body,version FROM app.comments WHERE org_id=$1 AND author_membership_id=$2 AND client_key=$3",
              [r.params.orgId, member.id, r.body.clientKey],
            )
          ).rows[0];
          if (prior) {
            if (
              prior.issue_id !== r.params.issueId ||
              prior.body !== r.body.body ||
              prior.version !== 1
            )
              throw new Problem(
                409,
                "comment_retry_conflict",
                "This comment request was already used. Refresh comments before trying again.",
              );
            return { id: prior.id };
          }
          const row = (
            await tx.query(
              "INSERT INTO app.comments(org_id,project_id,issue_id,author_membership_id,body,client_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
              [
                r.params.orgId,
                issue.project_id,
                r.params.issueId,
                member.id,
                r.body.body,
                r.body.clientKey,
              ],
            )
          ).rows[0];
          await tx.query(
            "INSERT INTO app.activity_events(org_id,project_id,issue_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4,'comment.created',$5)",
            [
              r.params.orgId,
              issue.project_id,
              r.params.issueId,
              member.id,
              JSON.stringify({ commentId: row.id }),
            ],
          );
          return row;
        },
      );
      return reply.code(201).send(result);
    },
  );
  const Headers = Type.Object({
    "if-match": Type.String({ pattern: '^"[1-9][0-9]{0,8}"$' }),
  });
  for (const method of ["PATCH", "DELETE"] as const) {
    api.route<{
      Params: Static<typeof CommentParams>;
      Body: Static<typeof CommentPatch>;
      Headers: { "if-match": string };
    }>({
      method,
      url: "/orgs/:orgId/comments/:commentId",
      schema: {
        params: CommentParams,
        ...(method === "PATCH" ? { body: CommentPatch } : {}),
        headers: Headers,
        security,
      },
      handler: async (r, reply) => {
        await withTenant(
          pool,
          r.identity,
          r.params.orgId,
          async (tx, member) => {
            const comment = (
              await tx.query(
                "SELECT * FROM app.comments WHERE org_id=$1 AND id=$2",
                [r.params.orgId, r.params.commentId],
              )
            ).rows[0];
            if (!comment)
              throw new Problem(404, "not_found", "Comment not found.");
            await projectAccess(tx, r.params.orgId, comment.project_id, true);
            if (
              comment.author_membership_id !== member.id &&
              (method === "PATCH" || member.role === "member")
            )
              throw new Problem(
                403,
                "forbidden",
                "You can edit your own comments; administrators can remove comments.",
              );
            const updated = await tx.query(
              `UPDATE app.comments SET body=$4,version=version+1,${method === "DELETE" ? "deleted_at=now()" : "edited_at=now()"} WHERE org_id=$1 AND id=$2 AND version=$3 AND deleted_at IS NULL RETURNING id`,
              [
                r.params.orgId,
                r.params.commentId,
                Number(r.headers["if-match"].slice(1, -1)),
                method === "DELETE" ? "" : r.body.body,
              ],
            );
            if (!updated.rowCount)
              throw new Problem(
                412,
                "stale_comment",
                "This comment changed. Refresh before trying again.",
              );
            await tx.query(
              "INSERT INTO app.activity_events(org_id,project_id,issue_id,actor_membership_id,action,changes) VALUES($1,$2,$3,$4,$5,$6)",
              [
                r.params.orgId,
                comment.project_id,
                comment.issue_id,
                member.id,
                method === "DELETE" ? "comment.deleted" : "comment.edited",
                JSON.stringify({ commentId: comment.id }),
              ],
            );
          },
        );
        return reply.code(204).send();
      },
    });
  }
}
