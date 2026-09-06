import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  assertRuntimeRole,
  withIdentity,
  withTenant,
} from "../src/database.js";
import { Problem } from "../src/problem.js";
import type { Identity } from "../src/identity.js";
import { migrate } from "../../../scripts/migrate.js";
const alice: Identity = {
  id: randomUUID(),
  displayName: "Alice",
  email: "alice@example.test",
  authenticatedAt: Math.floor(Date.now() / 1000),
  issuedAt: Math.floor(Date.now() / 1000),
  sessionId: randomUUID(),
};
const bob: Identity = {
  id: randomUUID(),
  displayName: "Bob",
  email: "bob@example.test",
  authenticatedAt: Math.floor(Date.now() / 1000),
  issuedAt: Math.floor(Date.now() / 1000),
  sessionId: randomUUID(),
};
const member: Identity = {
  id: randomUUID(),
  displayName: "Member",
  email: "member@example.test",
  authenticatedAt: Math.floor(Date.now() / 1000),
  issuedAt: Math.floor(Date.now() / 1000),
  sessionId: randomUUID(),
};
let app: FastifyInstance;
let pool: pg.Pool;
let admin: pg.Pool;
let orgA: string;
let orgB: string;
let projectA: string;
let projectB: string;
let memberA: string;
let memberB: string;
const headers = (who = alice) => ({ authorization: `Bearer ${who.id}` });
async function issue(
  title = "Book the venue",
  extra: Record<string, unknown> = {},
  key = randomUUID(),
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgA}/projects/${projectA}/issues`,
    headers: { ...headers(), "idempotency-key": key },
    payload: { title, ...extra },
  });
}
beforeAll(async () => {
  pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 2,
  });
  admin = new pg.Pool({
    connectionString: process.env.TEST_ADMIN_DATABASE_URL,
    max: 2,
  });
  app = await buildApp({
    pool,
    supabaseUrl: "http://127.0.0.1:54321",
    publicKey: "test-public",
    verifyIdentity: async (token) => {
      const identity = [alice, bob, member].find((x) => x.id === token);
      if (!identity) throw new Problem(401, "invalid_session", "Invalid token");
      return identity;
    },
  });
  for (const who of [alice, bob, member])
    expect(
      (await app.inject({ url: "/api/v1/me", headers: headers(who) }))
        .statusCode,
    ).toBe(200);
  async function org(who: Identity, name: string) {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: headers(who),
      payload: {
        name,
        slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  orgA = await org(alice, "ClubA");
  orgB = await org(bob, "ClubB");
  async function project(who: Identity, org: string) {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/projects`,
      headers: headers(who),
      payload: { name: "Event planning", key: "EVENT" },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }
  projectA = await project(alice, orgA);
  projectB = await project(bob, orgB);
  memberA = (
    await admin.query(
      "INSERT INTO app.memberships(org_id,user_id,role) VALUES($1,$2,'member') RETURNING id",
      [orgA, member.id],
    )
  ).rows[0].id;
  memberB = (
    await admin.query("SELECT id FROM app.memberships WHERE org_id=$1", [orgB])
  ).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.end();
});
describe("real PostgreSQL foundation", () => {
  it("uses a restricted runtime and rejects an owner/superuser connection", async () => {
    await expect(assertRuntimeRole(pool)).resolves.toBeUndefined();
    await expect(assertRuntimeRole(admin)).rejects.toThrow("non-owner");
  });
  it("reapplies unchanged migrations without modifying the database", async () => {
    await expect(
      migrate(process.env.TEST_ADMIN_DATABASE_URL!),
    ).resolves.toBeUndefined();
  });
  it("requires authentication and rejects malformed or mass-assigned input", async () => {
    expect((await app.inject({ url: "/api/v1/me" })).statusCode).toBe(401);
    expect((await issue("Escalate", { org_id: orgB })).statusCode).toBe(400);
    expect((await issue("   ")).statusCode).toBe(400);
    expect(
      (await issue("Bad date", { dueDate: "2026-02-30" })).statusCode,
    ).toBe(400);
  });
  it("lists only own organizations and blocks other-tenant routes", async () => {
    const r = await app.inject({
      url: "/api/v1/me/organizations",
      headers: headers(),
    });
    expect(r.json().map((o: { id: string }) => o.id)).toEqual([orgA]);
    expect(
      (
        await app.inject({
          url: `/api/v1/orgs/${orgB}/projects`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v1/orgs/${orgA}/projects/${projectB}/issues`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(404);
  });
  it("creates one task, activity, and durable event atomically", async () => {
    const r = await issue();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.headers.etag).toBe('"1"');
    expect(r.json().org_id).toBeUndefined();
    const counts = await admin.query(
      "SELECT (SELECT count(*) FROM app.activity_events WHERE issue_id=$1) AS events,(SELECT count(*) FROM app.outbox_jobs WHERE payload->>'issueId'=$1::text) AS jobs",
      [r.json().id],
    );
    expect(counts.rows[0]).toEqual({ events: "1", jobs: "1" });
  });
  it("retries concurrent creates once and rejects changed idempotency payloads", async () => {
    const key = randomUUID();
    const results = await Promise.all([
      issue("One task", {}, key),
      issue("One task", {}, key),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(results[0]!.json().id).toBe(results[1]!.json().id);
    expect((await issue("Changed task", {}, key)).statusCode).toBe(409);
  });
  it("allocates distinct project issue numbers under concurrent writes", async () => {
    const results = await Promise.all([issue("A"), issue("B")]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(new Set(results.map((r) => r.json().number)).size).toBe(2);
  });
  it("rejects foreign and inactive assignees without committing partial records", async () => {
    expect(
      (await issue("Wrong assignee", { assigneeMembershipId: memberB }))
        .statusCode,
    ).toBe(400);
    await admin.query(
      "UPDATE app.memberships SET state='inactive' WHERE id=$1",
      [memberA],
    );
    expect(
      (await issue("Inactive assignee", { assigneeMembershipId: memberA }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/v1/orgs/${orgA}/projects`,
          headers: headers(member),
        })
      ).statusCode,
    ).toBe(404);
    await admin.query("UPDATE app.memberships SET state='active' WHERE id=$1", [
      memberA,
    ]);
    expect(
      (
        await admin.query(
          "SELECT id FROM app.issues WHERE title IN ('Wrong assignee','Inactive assignee')",
        )
      ).rowCount,
    ).toBe(0);
  });
  it("allows members to contribute but not create projects", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/orgs/${orgA}/projects`,
          headers: headers(member),
          payload: { name: "Unauthorized", key: "NO" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/orgs/${orgA}/projects/${projectA}/issues`,
          headers: { ...headers(member), "idempotency-key": randomUUID() },
          payload: { title: "Member contribution" },
        })
      ).statusCode,
    ).toBe(201);
  });
  it("prevents stale edits and moves completed backlog work into planned work", async () => {
    const created = (
      await issue("Finish this", { planningState: "backlog" })
    ).json();
    const url = `/api/v1/orgs/${orgA}/issues/${created.id}`;
    const r = await app.inject({
      method: "PATCH",
      url,
      headers: { ...headers(), "if-match": '"1"' },
      payload: { status: "done" },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().planning_state).toBe("planned");
    expect(r.headers.etag).toBe('"2"');
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: { ...headers(), "if-match": '"1"' },
          payload: { status: "todo" },
        })
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url,
          headers: { ...headers(), "if-match": '"2"' },
          payload: { planningState: "backlog" },
        })
      ).statusCode,
    ).toBe(409);
    expect((await app.inject({ url, headers: headers(bob) })).statusCode).toBe(
      404,
    );
  });
  it("paginates without duplicate IDs and bounds page size", async () => {
    const url = `/api/v1/orgs/${orgA}/projects/${projectA}/issues`;
    const first = (
      await app.inject({ url: `${url}?limit=2`, headers: headers() })
    ).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (
      await app.inject({
        url: `${url}?limit=2&after=${first.nextCursor}`,
        headers: headers(),
      })
    ).json();
    expect(
      new Set([...first.items, ...second.items].map((i) => i.id)).size,
    ).toBe(4);
    expect(
      (await app.inject({ url: `${url}?limit=10000`, headers: headers() }))
        .statusCode,
    ).toBe(400);
  });
  it("enforces RLS without an organization filter and fails closed without context", async () => {
    expect((await pool.query("SELECT * FROM app.issues")).rowCount).toBe(0);
    await withTenant(pool, alice, orgA, async (tx) => {
      expect(
        (await tx.query("SELECT * FROM app.projects WHERE id=$1", [projectB]))
          .rowCount,
      ).toBe(0);
    });
    expect((await pool.query("SELECT * FROM app.projects")).rowCount).toBe(0);
  });
  it("does not leak tenant context after transaction rollback or reuse", async () => {
    await expect(
      withTenant(pool, alice, orgA, async (tx) => {
        await tx.query("SELECT * FROM app.projects");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await withTenant(pool, bob, orgB, async (tx) => {
      expect(
        (await tx.query("SELECT id FROM app.projects")).rows.map((r) => r.id),
      ).toEqual([projectB]);
    });
    expect((await pool.query("SELECT * FROM app.issues")).rowCount).toBe(0);
  });
  it("database foreign keys reject a cross-tenant project even with matching RLS org", async () => {
    await expect(
      withTenant(pool, alice, orgA, async (tx, m) =>
        tx.query(
          "INSERT INTO app.issues(org_id,project_id,number,title,creator_membership_id,rank) VALUES($1,$2,999,'Invalid',$3,1)",
          [orgA, projectB, m.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("rejects archived project writes", async () => {
    await admin.query("UPDATE app.projects SET archived_at=now() WHERE id=$1", [
      projectA,
    ]);
    expect((await issue("Archived write")).statusCode).toBe(409);
    await admin.query("UPDATE app.projects SET archived_at=NULL WHERE id=$1", [
      projectA,
    ]);
  });
  it("denies disabled identities", async () => {
    await admin.query("UPDATE app.users SET disabled_at=now() WHERE id=$1", [
      member.id,
    ]);
    expect(
      (await app.inject({ url: "/api/v1/me", headers: headers(member) }))
        .statusCode,
    ).toBe(401);
    await admin.query("UPDATE app.users SET disabled_at=NULL WHERE id=$1", [
      member.id,
    ]);
  });
  it("publishes API contracts and keeps provider/server secrets out of public config", async () => {
    const spec = (await app.inject({ url: "/api/openapi.json" })).json();
    expect(
      spec.paths["/api/v1/orgs/{orgId}/projects/{projectId}/issues"],
    ).toBeDefined();
    expect(
      Object.keys((await app.inject({ url: "/api/config" })).json()).sort(),
    ).toEqual(["supabasePublicKey", "supabaseUrl"]);
  });
  it("revokes API access immediately on logout", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/logout",
          headers: headers(member),
        })
      ).statusCode,
    ).toBe(204);
    await expect(
      withIdentity(pool, member, async () => true),
    ).rejects.toMatchObject({ status: 401 });
  });
});
