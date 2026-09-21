import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { withTenant } from "../src/database.js";
import type { Identity } from "../src/identity.js";
import { Problem } from "../src/problem.js";
const identities = new Map<string, Identity>();
function person(name: string): Identity {
  const p = {
    id: randomUUID(),
    email: `${name}-${randomUUID()}@example.test`,
    displayName: name,
    issuedAt: Math.floor(Date.now() / 1000),
    authenticatedAt: Math.floor(Date.now() / 1000),
    sessionId: randomUUID(),
  };
  identities.set(p.id, p);
  return p;
}
const owner = person("Owner"),
  adminUser = person("Admin"),
  member = person("Member"),
  outside = person("Outside");
const headers = (user = owner) => ({ authorization: `Bearer ${user.id}` });
let app: FastifyInstance,
  pool: pg.Pool,
  db: pg.Pool,
  orgId: string,
  otherOrg: string,
  ownerId: string,
  adminId: string,
  memberId: string;
async function createOrg(user: Identity) {
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/orgs",
    headers: headers(user),
    payload: { name: "Club", slug: `club-${randomUUID().slice(0, 8)}` },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}
async function addMember(user: Identity, role = "member", org = orgId) {
  await app.inject({ url: "/api/v1/me", headers: headers(user) });
  return (
    await db.query(
      "INSERT INTO app.memberships(org_id,user_id,role,display_name) VALUES($1,$2,$3,$4) RETURNING id",
      [org, user.id, role, user.displayName],
    )
  ).rows[0].id as string;
}
async function invite(user: Identity, role = "member", actor = owner) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/invitations`,
    headers: headers(actor),
    payload: { email: user.email.toUpperCase(), role },
  });
}
async function accept(user: Identity, token: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/invitations/accept",
    headers: headers(user),
    payload: { token },
  });
}
beforeAll(async () => {
  pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 4,
  });
  db = new pg.Pool({
    connectionString: process.env.TEST_ADMIN_DATABASE_URL,
    max: 2,
  });
  app = await buildApp({
    pool,
    supabaseUrl: "http://127.0.0.1:54321",
    publicKey: "test-public",
    verifyIdentity: async (token) => {
      const p = identities.get(token);
      if (!p) throw new Problem(401, "invalid_session", "Sign in");
      return p;
    },
  });
  orgId = await createOrg(owner);
  otherOrg = await createOrg(outside);
  ownerId = (
    await db.query("SELECT id FROM app.memberships WHERE org_id=$1", [orgId])
  ).rows[0].id;
  adminId = await addMember(adminUser, "admin");
  memberId = await addMember(member);
});
afterAll(async () => {
  await app.close();
  await pool.end();
  await db.end();
});
it("returns names and roles without exposing other organizations or global user profiles", async () => {
  const response = await app.inject({
    url: `/api/v1/orgs/${orgId}/members`,
    headers: headers(member),
  });
  expect(response.statusCode).toBe(200);
  expect(
    response.json().find((m: { id: string }) => m.id === memberId).display_name,
  ).toBe("Member");
  expect(
    (
      await app.inject({
        url: `/api/v1/orgs/${otherOrg}/members`,
        headers: headers(member),
      })
    ).statusCode,
  ).toBe(404);
});
it("accepts a hashed, email-bound invite once, including concurrent acceptance", async () => {
  const joiner = person("Joiner");
  const created = await invite(joiner);
  expect(created.statusCode, created.body).toBe(201);
  const link = created.json();
  const stored = (
    await db.query("SELECT token_hash FROM app.invitations WHERE id=$1", [
      link.id,
    ])
  ).rows[0];
  expect(stored.token_hash).not.toBe(link.token);
  expect(stored.token_hash).toHaveLength(64);
  expect((await accept(outside, link.token)).statusCode).toBe(404);
  const attempts = await Promise.all([
    accept(joiner, link.token),
    accept(joiner, link.token),
  ]);
  expect(attempts.map((r) => r.statusCode).sort()).toEqual([201, 404]);
  expect(
    (
      await db.query(
        "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
        [orgId, joiner.id],
      )
    ).rowCount,
  ).toBe(1);
  const listed = (
    await app.inject({
      url: `/api/v1/orgs/${orgId}/invitations`,
      headers: headers(),
    })
  ).json();
  expect(
    listed.find((i: { id: string }) => i.id === link.id).token_hash,
  ).toBeUndefined();
  expect(
    listed.find((i: { id: string }) => i.id === link.id).token,
  ).toBeUndefined();
});
it("does not permit member invites or admin privilege escalation", async () => {
  expect((await invite(person("No"), "member", member)).statusCode).toBe(403);
  expect((await invite(person("NoAdmin"), "admin", adminUser)).statusCode).toBe(
    403,
  );
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/members/${adminId}`,
        headers: headers(adminUser),
        payload: { role: "owner" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        url: `/api/v1/orgs/${orgId}/invitations`,
        headers: headers(member),
      })
    ).statusCode,
  ).toBe(403);
});
it("rejects expired, revoked, and over-privileged invitations", async () => {
  const expired = person("Expired");
  const old = (await invite(expired)).json();
  await db.query(
    "UPDATE app.invitations SET created_at=now()-interval '9 days',expires_at=now()-interval '2 days' WHERE id=$1",
    [old.id],
  );
  expect((await accept(expired, old.token)).statusCode).toBe(404);
  const revoked = person("Revoked");
  const link = (await invite(revoked)).json();
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/invitations/${link.id}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(204);
  expect((await accept(revoked, link.token)).statusCode).toBe(404);
  const pending = person("Pending");
  const adminInvite = (await invite(pending, "member", adminUser)).json();
  await db.query("UPDATE app.memberships SET role='member' WHERE id=$1", [
    adminId,
  ]);
  expect((await accept(pending, adminInvite.token)).statusCode).toBe(404);
  await db.query("UPDATE app.memberships SET role='admin' WHERE id=$1", [
    adminId,
  ]);
});
it("requires a recent authentication event rather than a recently refreshed token", async () => {
  const authenticatedAt = owner.authenticatedAt;
  owner.authenticatedAt = Math.floor(Date.now() / 1000) - 3600;
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/members/${memberId}`,
        headers: headers(),
        payload: { role: "admin" },
      })
    ).statusCode,
  ).toBe(403);
  owner.authenticatedAt = authenticatedAt;
});
it("rejects last-owner demotion in the API and directly in PostgreSQL", async () => {
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/v1/orgs/${orgId}/members/${ownerId}`,
        headers: headers(),
        payload: { role: "member" },
      })
    ).statusCode,
  ).toBe(409);
  await expect(
    db.query("UPDATE app.memberships SET state='inactive' WHERE id=$1", [
      ownerId,
    ]),
  ).rejects.toMatchObject({ code: "P0004" });
  expect(
    (
      await db.query("SELECT role,state FROM app.memberships WHERE id=$1", [
        ownerId,
      ])
    ).rows[0],
  ).toEqual({ role: "owner", state: "active" });
});
it("transfers ownership atomically and removes the previous owner privilege", async () => {
  const outgoing = person("Outgoing"),
    incoming = person("Incoming");
  const org = await createOrg(outgoing);
  const next = await addMember(incoming, "member", org);
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/ownership/transfer`,
    headers: headers(outgoing),
    payload: { membershipId: next },
  });
  expect(r.statusCode, r.body).toBe(204);
  const roles = (
    await db.query("SELECT user_id,role FROM app.memberships WHERE org_id=$1", [
      org,
    ])
  ).rows;
  expect(roles.find((r) => r.user_id === outgoing.id).role).toBe("admin");
  expect(roles.find((r) => r.user_id === incoming.id).role).toBe("owner");
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${org}/ownership/transfer`,
        headers: headers(outgoing),
        payload: { membershipId: next },
      })
    ).statusCode,
  ).toBe(403);
});
it("serializes concurrent owner demotions so an owner always survives", async () => {
  const first = person("First"),
    second = person("Second");
  const org = await createOrg(first);
  const next = await addMember(second, "owner", org);
  const firstId = (
    await db.query(
      "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
      [org, first.id],
    )
  ).rows[0].id;
  const results = await Promise.all([
    app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${org}/members/${firstId}`,
      headers: headers(first),
      payload: { role: "member" },
    }),
    app.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${org}/members/${next}`,
      headers: headers(second),
      payload: { role: "member" },
    }),
  ]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect(
    (
      await db.query(
        "SELECT id FROM app.memberships WHERE org_id=$1 AND role='owner' AND state='active'",
        [org],
      )
    ).rowCount,
  ).toBe(1);
});
it("keeps teams as tenant-scoped groups and rejects cross-tenant membership IDs", async () => {
  const created = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/teams`,
    headers: headers(adminUser),
    payload: { name: "Events" },
  });
  expect(created.statusCode).toBe(201);
  const team = created.json().id;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/teams/${team}/members/${memberId}`,
        headers: headers(adminUser),
      })
    ).statusCode,
  ).toBe(204);
  const foreign = (
    await db.query("SELECT id FROM app.memberships WHERE org_id=$1", [otherOrg])
  ).rows[0].id;
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/orgs/${orgId}/teams/${team}/members/${foreign}`,
        headers: headers(),
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/teams`,
        headers: headers(member),
        payload: { name: "Forbidden" },
      })
    ).statusCode,
  ).toBe(403);
  const list = (
    await app.inject({
      url: `/api/v1/orgs/${orgId}/teams`,
      headers: headers(member),
    })
  ).json();
  expect(list.find((t: { id: string }) => t.id === team).member_ids).toContain(
    memberId,
  );
  await expect(
    withTenant(pool, owner, orgId, (tx) =>
      tx.query(
        "INSERT INTO app.team_members(org_id,team_id,membership_id) VALUES($1,$2,$3)",
        [orgId, team, foreign],
      ),
    ),
  ).rejects.toMatchObject({ code: "23503" });
});
it("removes access, clears active work/team membership, preserves attribution, and revokes invites", async () => {
  const retiring = person("Retiring");
  const retireId = await addMember(retiring, "admin");
  const project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects`,
      headers: headers(retiring),
      payload: { name: "Handoff", key: "HAND" },
    })
  ).json();
  const issue = (
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/projects/${project.id}/issues`,
      headers: { ...headers(retiring), "idempotency-key": randomUUID() },
      payload: { title: "Finish planning", assigneeMembershipId: retireId },
    })
  ).json();
  const pending = (await invite(person("Later"), "member", retiring)).json();
  const result = await app.inject({
    method: "DELETE",
    url: `/api/v1/orgs/${orgId}/members/${retireId}`,
    headers: headers(),
  });
  expect(result.statusCode, result.body).toBe(204);
  expect(
    (
      await app.inject({
        url: `/api/v1/orgs/${orgId}/projects`,
        headers: headers(retiring),
      })
    ).statusCode,
  ).toBe(404);
  const saved = (
    await db.query(
      "SELECT assignee_membership_id,creator_membership_id,version FROM app.issues WHERE id=$1",
      [issue.id],
    )
  ).rows[0];
  expect(saved).toEqual({
    assignee_membership_id: null,
    creator_membership_id: retireId,
    version: 2,
  });
  expect(
    (
      await db.query(
        "SELECT lead_membership_id FROM app.projects WHERE id=$1",
        [project.id],
      )
    ).rows[0].lead_membership_id,
  ).toBe(ownerId);
  expect(
    (
      await db.query("SELECT revoked_at FROM app.invitations WHERE id=$1", [
        pending.id,
      ])
    ).rows[0].revoked_at,
  ).toBeTruthy();
});
it("does not let a consumed invitation reactivate a removed member", async () => {
  const leaving = person("Leaving");
  const token = (await invite(leaving)).json().token;
  expect((await accept(leaving, token)).statusCode).toBe(201);
  const id = (
    await db.query(
      "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
      [orgId, leaving.id],
    )
  ).rows[0].id;
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/orgs/${orgId}/members/${id}`,
        headers: headers(leaving),
      })
    ).statusCode,
  ).toBe(204);
  expect((await accept(leaving, token)).statusCode).toBe(404);
});
