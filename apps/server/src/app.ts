import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import staticFiles from "@fastify/static";
import { Type, type Static } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import type pg from "pg";
import {
  OrgInput,
  ProjectInput,
  IssueInput,
  IssuePatch,
  OrgParams,
  ProjectParams,
  IssueParams,
  PageQuery,
  IssueResponse,
} from "@lira/contracts";
import type { VerifyIdentity, Identity } from "./identity.js";
import { withIdentity, withTenant } from "./database.js";
import { Problem } from "./problem.js";
import { createIssue, listIssues, updateIssue } from "./work.js";
import { organizationRoutes } from "./organization-routes.js";
import { commentRoutes } from "./comment-routes.js";
import { notificationRoutes } from "./notification-routes.js";
import { workflowRoutes } from "./workflow-routes.js";
import { requireAdmin } from "./policy.js";

import { attachmentRoutes } from "./attachment-routes.js";
import type { AttachmentOptions } from "./storage.js";
export interface AppOptions {
  attachments?: AttachmentOptions;
  pool: pg.Pool;
  assignmentEmailEnabled?: boolean;
  verifyIdentity: VerifyIdentity;
  supabaseUrl: string;
  publicKey: string;
  webRoot?: string;
  logger?: boolean;
  revokeProvider?: (token: string) => Promise<void>;
}
export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
          ],
          level: "info",
        }
      : false,
    bodyLimit: 32768,
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'", options.supabaseUrl],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(swagger, {
    openapi: {
      info: { title: "Lira API", version: "0.1.0" },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Problem)
      return reply.code(error.status).send({
        code: error.code,
        message: error.message,
        requestId: request.id,
      });
    const err = error as {
      validation?: unknown;
      code?: string;
      statusCode?: number;
    };
    if (err.validation)
      return reply.code(400).send({
        code: "invalid_request",
        message: "Check the request fields and try again.",
        requestId: request.id,
      });
    if (err.code === "23505")
      return reply.code(409).send({
        code: "already_exists",
        message: "That name, key, or request already exists.",
        requestId: request.id,
      });
    if (["23503", "23514", "22007", "22008"].includes(err.code ?? ""))
      return reply.code(400).send({
        code: "invalid_reference",
        message: "One or more fields are invalid.",
        requestId: request.id,
      });
    if (err.code === "P0002")
      return reply.code(404).send({
        code: "invitation_unavailable",
        message:
          "This invitation is expired, used, revoked, or for a different email.",
        requestId: request.id,
      });
    if (err.code === "P0003")
      return reply.code(409).send({
        code: "already_member",
        message: "You already belong to this workspace.",
        requestId: request.id,
      });
    if (err.code === "P0004")
      return reply.code(409).send({
        code: "last_owner",
        message: "A workspace must retain at least one active owner.",
        requestId: request.id,
      });
    if (err.code === "P0001")
      return reply.code(429).send({
        code: "pilot_limit",
        message:
          "This action would exceed a pilot workspace or membership limit.",
        requestId: request.id,
      });
    if (err.statusCode === 429)
      return reply.code(429).send({
        code: "rate_limited",
        message: "Too many requests. Please wait a moment.",
        requestId: request.id,
      });
    request.log.error({ err: error }, "Request failed");
    return reply.code(500).send({
      code: "internal_error",
      message: "Something went wrong. Please try again.",
      requestId: request.id,
    });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await options.pool
        .query("SELECT to_regclass('app.issues') AS table_name")
        .then((r) => {
          if (!r.rows[0]?.table_name) throw new Error("Missing migration");
        });
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/api/config", async () => ({
    supabaseUrl: options.supabaseUrl,
    supabasePublicKey: options.publicKey,
  }));
  app.get("/api/openapi.json", async () => app.swagger());
  await app.register(
    async (api) => {
      api.decorateRequest("identity");
      api.addHook("preHandler", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ") || header.length > 8192)
          throw new Problem(401, "authentication_required", "Please sign in.");
        request.identity = await options.verifyIdentity(header.slice(7));
      });
      const security = [{ bearerAuth: [] }];
      api.get("/me", { schema: { security } }, async (request) =>
        withIdentity(
          options.pool,
          request.identity,
          async (tx) =>
            (
              await tx.query(
                "SELECT id,display_name FROM app.users WHERE id=$1",
                [request.identity.id],
              )
            ).rows[0],
        ),
      );
      api.get("/me/organizations", { schema: { security } }, async (request) =>
        withIdentity(
          options.pool,
          request.identity,
          async (tx) =>
            (
              await tx.query(
                "SELECT o.id,o.name,o.slug,m.role FROM app.organizations o JOIN app.memberships m ON m.org_id=o.id WHERE m.user_id=$1 AND m.state='active' ORDER BY o.created_at,o.id",
                [request.identity.id],
              )
            ).rows,
        ),
      );
      api.post<{ Body: Static<typeof OrgInput> }>(
        "/orgs",
        {
          schema: { body: OrgInput, security },
          config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
        },
        async (request, reply) => {
          const org = await withIdentity(
            options.pool,
            request.identity,
            async (tx) =>
              (
                await tx.query("SELECT * FROM app.create_organization($1,$2)", [
                  request.body.name,
                  request.body.slug,
                ])
              ).rows[0],
          );
          return reply.code(201).send({ ...org, role: "owner" });
        },
      );
      await organizationRoutes(api, options.pool);
      await workflowRoutes(api, options.pool);
      await commentRoutes(api, options.pool);
      await attachmentRoutes(api, options.pool, options.attachments);
      await notificationRoutes(
        api,
        options.pool,
        options.assignmentEmailEnabled,
      );
      api.get<{ Params: Static<typeof OrgParams> }>(
        "/orgs/:orgId/projects",
        { schema: { params: OrgParams, security } },
        async (request) =>
          withTenant(
            options.pool,
            request.identity,
            request.params.orgId,
            async (tx) =>
              (
                await tx.query(
                  "SELECT id,name,key,description,lead_membership_id,archived_at FROM app.projects WHERE org_id=$1 ORDER BY created_at,id LIMIT 100",
                  [request.params.orgId],
                )
              ).rows,
          ),
      );
      api.post<{
        Params: Static<typeof OrgParams>;
        Body: Static<typeof ProjectInput>;
      }>(
        "/orgs/:orgId/projects",
        { schema: { params: OrgParams, body: ProjectInput, security } },
        async (request, reply) => {
          const project = await withTenant(
            options.pool,
            request.identity,
            request.params.orgId,
            async (tx, member) => {
              requireAdmin(member);
              const { rows } = await tx.query(
                "INSERT INTO app.projects(org_id,name,key,description,lead_membership_id) VALUES($1,$2,$3,$4,$5) RETURNING id,name,key,description,lead_membership_id,archived_at",
                [
                  request.params.orgId,
                  request.body.name,
                  request.body.key,
                  request.body.description ?? "",
                  member.id,
                ],
              );
              await tx.query(
                "INSERT INTO app.boards(org_id,project_id) VALUES($1,$2)",
                [request.params.orgId, rows[0].id],
              );
              return rows[0];
            },
          );
          return reply.code(201).send(project);
        },
      );
      api.get<{
        Params: Static<typeof ProjectParams>;
        Querystring: Static<typeof PageQuery>;
      }>(
        "/orgs/:orgId/projects/:projectId/issues",
        {
          schema: {
            params: ProjectParams,
            querystring: PageQuery,
            security,
            response: {
              200: Type.Object({
                items: Type.Array(IssueResponse),
                nextCursor: Type.Union([Type.String(), Type.Null()]),
              }),
            },
          },
        },
        async (request) =>
          withTenant(
            options.pool,
            request.identity,
            request.params.orgId,
            (tx) =>
              listIssues(
                tx,
                request.params.orgId,
                request.params.projectId,
                request.query.limit ?? 50,
                request.query.after,
                request.query.planningState,
                request.query,
              ),
          ),
      );
      api.post<{
        Params: Static<typeof ProjectParams>;
        Body: Static<typeof IssueInput>;
        Headers: { "idempotency-key": string };
      }>(
        "/orgs/:orgId/projects/:projectId/issues",
        {
          schema: {
            params: ProjectParams,
            body: IssueInput,
            headers: Type.Object({
              "idempotency-key": Type.String({ format: "uuid" }),
            }),
            security,
            response: { 201: IssueResponse },
          },
        },
        async (request, reply) => {
          const issue = await withTenant(
            options.pool,
            request.identity,
            request.params.orgId,
            (tx, member) =>
              createIssue(
                tx,
                request.params.orgId,
                request.params.projectId,
                member,
                request.body,
                request.headers["idempotency-key"],
              ),
          );
          return reply
            .code(201)
            .header("ETag", `"${issue.version}"`)
            .header(
              "Location",
              `/api/v1/orgs/${request.params.orgId}/issues/${issue.id}`,
            )
            .send(issue);
        },
      );
      api.get<{ Params: Static<typeof IssueParams> }>(
        "/orgs/:orgId/issues/:issueId",
        {
          schema: {
            params: IssueParams,
            security,
            response: { 200: IssueResponse },
          },
        },
        async (request, reply) => {
          const issue = await withTenant(
            options.pool,
            request.identity,
            request.params.orgId,
            async (tx) => {
              const r = await tx.query(
                "SELECT *,to_char(due_date,'YYYY-MM-DD') AS due_date FROM app.issues WHERE org_id=$1 AND id=$2",
                [request.params.orgId, request.params.issueId],
              );
              if (!r.rows[0])
                throw new Problem(404, "not_found", "Task not found.");
              return r.rows[0];
            },
          );
          return reply.header("ETag", `"${issue.version}"`).send(issue);
        },
      );
      api.patch<{
        Params: Static<typeof IssueParams>;
        Body: Static<typeof IssuePatch>;
        Headers: { "if-match": string };
      }>(
        "/orgs/:orgId/issues/:issueId",
        {
          schema: {
            params: IssueParams,
            body: IssuePatch,
            headers: Type.Object({
              "if-match": Type.String({ pattern: '^"[1-9][0-9]{0,8}"$' }),
            }),
            security,
            response: { 200: IssueResponse },
          },
        },
        async (request, reply) => {
          const issue = await withTenant(
            options.pool,
            request.identity,
            request.params.orgId,
            (tx, member) =>
              updateIssue(
                tx,
                request.params.orgId,
                request.params.issueId,
                member,
                request.body,
                Number(request.headers["if-match"].slice(1, -1)),
              ),
          );
          return reply.header("ETag", `"${issue.version}"`).send(issue);
        },
      );
      api.post(
        "/auth/logout",
        { schema: { security } },
        async (request, reply) => {
          await withIdentity(
            options.pool,
            request.identity,
            async (tx) => {
              await tx.query(
                "INSERT INTO app.revoked_sessions(session_id,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours') ON CONFLICT DO NOTHING",
                [request.identity.sessionId, request.identity.id],
              );
            },
            true,
          );
          if (options.revokeProvider)
            await options.revokeProvider(
              request.headers.authorization!.slice(7),
            );
          return reply.code(204).send();
        },
      );
    },
    { prefix: "/api/v1" },
  );
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(staticFiles, { root: options.webRoot, index: false });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        request.headers.accept?.includes("text/html")
      )
        return reply.type("text/html").sendFile("index.html");
      return reply.code(404).send({ code: "not_found", message: "Not found." });
    });
  }
  await app.ready();
  return app;
}
declare module "fastify" {
  interface FastifyRequest {
    identity: Identity;
  }
}
