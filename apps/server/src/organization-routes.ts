import { Type, type Static } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import {
  OrgParams,
  MemberParams,
  InviteParams,
  TeamParams,
  TeamMemberParams,
  InviteInput,
  AcceptInviteInput,
  MemberRoleInput,
  TransferInput,
  TeamInput,
  MemberResponse,
} from "@lira/contracts";
import { withIdentity, withTenant } from "./database.js";
import { requireAdmin } from "./policy.js";
import { Problem } from "./problem.js";
import {
  createInvitation,
  hashInvite,
  revokeInvitation,
  organizationEvent,
  changeRole,
  transferOwnership,
  removeMember,
} from "./organization.js";
import type { InvitationMailConfig } from "./invitation-email.js";
export async function organizationRoutes(
  api: FastifyInstance,
  pool: pg.Pool,
  mail?: InvitationMailConfig,
) {
  const security = [{ bearerAuth: [] }];
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/members",
    {
      schema: {
        params: OrgParams,
        security,
        response: { 200: Type.Array(MemberResponse) },
      },
    },
    async (request) =>
      withTenant(
        pool,
        request.identity,
        request.params.orgId,
        async (tx) =>
          (
            await tx.query(
              "SELECT id,user_id,role,display_name,state FROM app.memberships WHERE org_id=$1 AND state='active' ORDER BY created_at,id LIMIT 100",
              [request.params.orgId],
            )
          ).rows,
      ),
  );
  api.patch<{
    Params: Static<typeof MemberParams>;
    Body: Static<typeof MemberRoleInput>;
  }>(
    "/orgs/:orgId/members/:membershipId",
    { schema: { params: MemberParams, body: MemberRoleInput, security } },
    async (request) =>
      withTenant(
        pool,
        request.identity,
        request.params.orgId,
        (tx, member) =>
          changeRole(
            tx,
            request.params.orgId,
            member,
            request.params.membershipId,
            request.body.role,
            request.identity,
          ),
        "exclusive",
      ),
  );
  api.delete<{ Params: Static<typeof MemberParams> }>(
    "/orgs/:orgId/members/:membershipId",
    { schema: { params: MemberParams, security } },
    async (request, reply) => {
      await withTenant(
        pool,
        request.identity,
        request.params.orgId,
        (tx, member) =>
          removeMember(
            tx,
            request.params.orgId,
            member,
            request.params.membershipId,
            request.identity,
          ),
        "exclusive",
      );
      return reply.code(204).send();
    },
  );
  api.post<{
    Params: Static<typeof OrgParams>;
    Body: Static<typeof TransferInput>;
  }>(
    "/orgs/:orgId/ownership/transfer",
    { schema: { params: OrgParams, body: TransferInput, security } },
    async (request, reply) => {
      await withTenant(
        pool,
        request.identity,
        request.params.orgId,
        (tx, member) =>
          transferOwnership(
            tx,
            request.params.orgId,
            member,
            request.body.membershipId,
            request.identity,
          ),
        "exclusive",
      );
      return reply.code(204).send();
    },
  );
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/invitations",
    { schema: { params: OrgParams, security } },
    async (request) =>
      withTenant(
        pool,
        request.identity,
        request.params.orgId,
        async (tx, member) => {
          requireAdmin(member);
          return (
            await tx.query(
              "SELECT i.id,i.email,i.role,i.expires_at,i.accepted_at,i.revoked_at,i.created_at,CASE WHEN e.state='queued' AND (i.revoked_at IS NOT NULL OR i.accepted_at IS NOT NULL) THEN 'cancelled' WHEN e.state='queued' AND e.expires_at<=now() THEN 'expired' WHEN e.state='queued' AND j.state='failed' THEN 'failed' ELSE COALESCE(e.state,'manual') END AS email_status FROM app.invitations i LEFT JOIN app.invitation_emails e ON e.org_id=i.org_id AND e.invitation_id=i.id LEFT JOIN app.outbox_jobs j ON j.org_id=e.org_id AND j.event_id=e.event_id WHERE i.org_id=$1 ORDER BY i.created_at DESC,i.id LIMIT 100",
              [request.params.orgId],
            )
          ).rows;
        },
      ),
  );
  api.post<{
    Params: Static<typeof OrgParams>;
    Body: Static<typeof InviteInput>;
  }>(
    "/orgs/:orgId/invitations",
    {
      schema: { params: OrgParams, body: InviteInput, security },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await withTenant(
            pool,
            request.identity,
            request.params.orgId,
            (tx, member) =>
              createInvitation(
                tx,
                request.params.orgId,
                member,
                request.body.email,
                request.body.role,
                mail,
              ),
            "exclusive",
          ),
        ),
  );
  api.delete<{ Params: Static<typeof InviteParams> }>(
    "/orgs/:orgId/invitations/:invitationId",
    { schema: { params: InviteParams, security } },
    async (request, reply) => {
      await withTenant(
        pool,
        request.identity,
        request.params.orgId,
        (tx, member) =>
          revokeInvitation(
            tx,
            request.params.orgId,
            member,
            request.params.invitationId,
          ),
        "exclusive",
      );
      return reply.code(204).send();
    },
  );
  api.post<{ Body: Static<typeof AcceptInviteInput> }>(
    "/invitations/accept",
    {
      schema: { body: AcceptInviteInput, security },
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const orgId = await withIdentity(pool, request.identity, async (tx) => {
        const result = await tx.query(
          "SELECT app.accept_invitation($1,$2) AS org_id",
          [
            hashInvite(request.body.token),
            request.identity.email.trim().toLowerCase(),
          ],
        );
        const id = result.rows[0].org_id as string;
        await tx.query("SELECT set_config('app.org_id',$1,true)", [id]);
        const member = (
          await tx.query(
            "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
            [id, request.identity.id],
          )
        ).rows[0];
        await tx.query(
          "UPDATE app.invitation_emails SET state='cancelled',encrypted_payload=NULL WHERE org_id=$1 AND invitation_id IN (SELECT id FROM app.invitations WHERE org_id=$1 AND token_hash=$2) AND state='queued'",
          [id, hashInvite(request.body.token)],
        );
        await organizationEvent(tx, id, member.id, "invitation.accepted", {});
        return id;
      });
      return reply.code(201).send({ orgId });
    },
  );
  api.get<{ Params: Static<typeof OrgParams> }>(
    "/orgs/:orgId/teams",
    { schema: { params: OrgParams, security } },
    async (request) =>
      withTenant(
        pool,
        request.identity,
        request.params.orgId,
        async (tx) =>
          (
            await tx.query(
              "SELECT t.id,t.name,coalesce(array_agg(tm.membership_id) FILTER(WHERE tm.membership_id IS NOT NULL),'{}') AS member_ids FROM app.teams t LEFT JOIN app.team_members tm ON tm.org_id=t.org_id AND tm.team_id=t.id WHERE t.org_id=$1 GROUP BY t.id ORDER BY t.name,t.id LIMIT 30",
              [request.params.orgId],
            )
          ).rows,
      ),
  );
  api.post<{
    Params: Static<typeof OrgParams>;
    Body: Static<typeof TeamInput>;
  }>(
    "/orgs/:orgId/teams",
    { schema: { params: OrgParams, body: TeamInput, security } },
    async (request, reply) => {
      const team = await withTenant(
        pool,
        request.identity,
        request.params.orgId,
        async (tx, member) => {
          requireAdmin(member);
          if (
            Number(
              (
                await tx.query(
                  "SELECT count(*) FROM app.teams WHERE org_id=$1",
                  [request.params.orgId],
                )
              ).rows[0].count,
            ) >= 30
          )
            throw new Problem(
              429,
              "team_limit",
              "This workspace has reached the pilot limit of 30 teams.",
            );
          const created = (
            await tx.query(
              "INSERT INTO app.teams(org_id,name) VALUES($1,$2) RETURNING id,name",
              [request.params.orgId, request.body.name.trim()],
            )
          ).rows[0];
          await organizationEvent(
            tx,
            request.params.orgId,
            member.id,
            "team.created",
            { teamId: created.id },
          );
          return { ...created, member_ids: [] };
        },
        "exclusive",
      );
      return reply.code(201).send(team);
    },
  );
  api.delete<{ Params: Static<typeof TeamParams> }>(
    "/orgs/:orgId/teams/:teamId",
    { schema: { params: TeamParams, security } },
    async (request, reply) => {
      await withTenant(
        pool,
        request.identity,
        request.params.orgId,
        async (tx, member) => {
          requireAdmin(member);
          const r = await tx.query(
            "DELETE FROM app.teams WHERE org_id=$1 AND id=$2 RETURNING id",
            [request.params.orgId, request.params.teamId],
          );
          if (!r.rowCount)
            throw new Problem(404, "not_found", "Team not found.");
          await organizationEvent(
            tx,
            request.params.orgId,
            member.id,
            "team.deleted",
            { teamId: request.params.teamId },
          );
        },
        "exclusive",
      );
      return reply.code(204).send();
    },
  );
  for (const method of ["PUT", "DELETE"] as const) {
    api.route<{ Params: Static<typeof TeamMemberParams> }>({
      method,
      url: "/orgs/:orgId/teams/:teamId/members/:membershipId",
      schema: { params: TeamMemberParams, security },
      handler: async (request, reply) => {
        await withTenant(
          pool,
          request.identity,
          request.params.orgId,
          async (tx, actor) => {
            requireAdmin(actor);
            const { orgId, teamId, membershipId } = request.params;
            if (
              !(
                await tx.query(
                  "SELECT id FROM app.teams WHERE org_id=$1 AND id=$2",
                  [orgId, teamId],
                )
              ).rowCount
            )
              throw new Problem(404, "not_found", "Team not found.");
            if (
              !(
                await tx.query(
                  "SELECT id FROM app.memberships WHERE org_id=$1 AND id=$2 AND state='active'",
                  [orgId, membershipId],
                )
              ).rowCount
            )
              throw new Problem(404, "not_found", "Member not found.");
            if (method === "PUT")
              await tx.query(
                "INSERT INTO app.team_members(org_id,team_id,membership_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
                [orgId, teamId, membershipId],
              );
            else
              await tx.query(
                "DELETE FROM app.team_members WHERE org_id=$1 AND team_id=$2 AND membership_id=$3",
                [orgId, teamId, membershipId],
              );
            await organizationEvent(
              tx,
              orgId,
              actor.id,
              method === "PUT" ? "team.member_added" : "team.member_removed",
              { teamId, membershipId },
            );
          },
          "exclusive",
        );
        return reply.code(204).send();
      },
    });
  }
}
