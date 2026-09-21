import { beforeAll, beforeEach, afterEach, afterAll, it, expect } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Identity } from "../src/identity.js";
import { withTenant } from "../src/database.js";
import { processJob, type ClaimedJob } from "../src/worker.js";
import type { ExportStorage } from "../src/export-storage.js";
import { cleanupNotifications } from "../../../scripts/notification-retention.js";
import { supabaseStorage } from "../src/storage.js";
const identity = (name: string): Identity => ({
  id: randomUUID(),
  displayName: name,
  email: `${name}@example.test`,
  sessionId: randomUUID(),
  issuedAt: Math.floor(Date.now() / 1000),
  authenticatedAt: Math.floor(Date.now() / 1000),
});
let app: FastifyInstance, pool: pg.Pool, admin: pg.Pool, worker: pg.Pool;
let owner: Identity,
  member: Identity,
  outsider: Identity,
  org: string,
  otherOrg: string,
  memberId: string;
const objects = new Map<string, Buffer>();
let failRead = false;
let onRead: (() => Promise<void>) | undefined;
const storage: ExportStorage = {
  async writeJson(key, value) {
    if (!objects.has(key)) objects.set(key, Buffer.from(JSON.stringify(value)));
  },
  async read(key) {
    if (failRead) throw new Error("provider_unavailable");
    await onRead?.();
    return objects.get(key)!;
  },
  async signDownload(key) {
    return `https://fixture.supabase.co/storage/v1/object/sign/${key}?token=fixture`;
  },
  async remove(key) {
    objects.delete(key);
  },
};
const headers = (who = owner) => ({ authorization: `Bearer ${who.id}` });
const get = (path: string, who = owner) =>
  app.inject({ url: `/api/v1/orgs/${org}${path}`, headers: headers(who) });
const project = (extra: Record<string, unknown> = {}, who = owner) =>
  app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/projects`,
    headers: headers(who),
    payload: {
      name: "Welcome week",
      key: `P${randomUUID().slice(0, 8).toUpperCase()}`,
      ...extra,
    },
  });
const requestExport = (who = owner, clientKey = randomUUID()) =>
  app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/exports`,
    headers: headers(who),
    payload: { clientKey },
  });
const download = (id: string, who = owner) =>
  app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/exports/${id}/download`,
    headers: headers(who),
  });
async function exportRow(id: string) {
  return (await admin.query("SELECT * FROM app.exports WHERE id=$1", [id]))
    .rows[0];
}
async function run(id: string, type = "export.generate") {
  const job = (
    await admin.query(
      "UPDATE app.outbox_jobs SET state='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds' WHERE org_id=$1 AND type=$2 AND payload->>'exportId'=$3 RETURNING id,org_id,lease_token,attempts",
      [org, type, id],
    )
  ).rows[0] as ClaimedJob;
  expect(job).toBeDefined();
  return processJob(worker, job, {
    appUrl: "https://lira.example.test",
    exportStorage: storage,
  });
}
beforeAll(() => {
  pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max: 3,
  });
  admin = new pg.Pool({
    connectionString: process.env.TEST_ADMIN_DATABASE_URL,
  });
  worker = new pg.Pool({
    connectionString: process.env.TEST_WORKER_DATABASE_URL,
  });
});
beforeEach(async () => {
  owner = identity("owner");
  member = identity("member");
  outsider = identity("outside");
  failRead = false;
  onRead = undefined;
  app = await buildApp({
    pool,
    supabaseUrl: "https://fixture.supabase.co",
    publicKey: "fixture",
    exportStorage: storage,
    verifyIdentity: async (token) =>
      [owner, member, outsider].find((x) => x.id === token)!,
  });
  for (const who of [owner, member, outsider])
    await app.inject({ url: "/api/v1/me", headers: headers(who) });
  async function createOrg(who: Identity) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: headers(who),
      payload: {
        name: "Overview club",
        slug: `overview-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id;
  }
  org = await createOrg(owner);
  otherOrg = await createOrg(outsider);
  memberId = (
    await admin.query(
      "INSERT INTO app.memberships(org_id,user_id,role,display_name) VALUES($1,$2,'member','Member') RETURNING id",
      [org, member.id],
    )
  ).rows[0].id;
});
afterEach(async () => {
  await app.close();
});
afterAll(async () => {
  await Promise.all([pool.end(), admin.end(), worker.end()]);
});
it("creates both bundled templates atomically and makes retries safe", async () => {
  const catalog = (await get("/templates")).json();
  expect(catalog.map((t: { id: string }) => t.id)).toEqual([
    "event",
    "semester",
  ]);
  const clientKey = randomUUID();
  const input = {
    key: "EVENT",
    templateId: "event",
    term: "Fall 2026",
    clientKey,
  };
  const created = await Promise.all([project(input), project(input)]);
  expect(created.map((r) => r.statusCode)).toEqual([201, 201]);
  const id = created[0]!.json().id;
  expect(created[1]!.json().id).toBe(id);
  expect((await project({ ...input, term: "Winter 2027" })).statusCode).toBe(
    409,
  );
  const tasks = (
    await admin.query(
      "SELECT number,assignee_membership_id,due_date FROM app.issues WHERE project_id=$1 ORDER BY number",
      [id],
    )
  ).rows;
  expect(tasks).toHaveLength(7);
  expect(tasks.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(
    tasks.every(
      (r) => r.assignee_membership_id === null && r.due_date === null,
    ),
  ).toBe(true);
  expect(
    (await project({ templateId: "semester", term: "Winter 2027" })).statusCode,
  ).toBe(201);
  expect((await project({ templateId: "arbitrary" })).statusCode).toBe(400);
  expect((await project({ templateId: "event" }, member)).statusCode).toBe(403);
  expect((await get("/projects")).json()).toHaveLength(2);
});
it("aggregates only active tenant projects and paginates personal tasks without counting completed work as overdue", async () => {
  const p = (await project()).json().id;
  const own = (
    await admin.query(
      "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
      [org, owner.id],
    )
  ).rows[0].id;
  // 23 open assignments plus one completed task. Dates deliberately straddle today.
  for (let n = 0; n < 24; n++) {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/projects/${p}/issues`,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: {
        title: `Task ${n}`,
        assigneeMembershipId: own,
        status: n === 23 ? "done" : "todo",
        dueDate: n === 22 ? "2999-01-01" : "2000-01-01",
      },
    });
    expect(r.statusCode, r.body).toBe(201);
  }
  const summary = (await get("/dashboard")).json();
  expect(summary.counts).toMatchObject({
    assigned: 23,
    overdue: 22,
    todo: 23,
    done: 1,
  });
  expect(summary.projects[0]).toMatchObject({
    total: 24,
    done: 1,
    overdue: 22,
  });
  const first = (await get("/dashboard/tasks?kind=mine")).json();
  expect(first.items).toHaveLength(20);
  const second = (
    await get(`/dashboard/tasks?kind=mine&after=${first.nextCursor}`)
  ).json();
  expect(second.items).toHaveLength(3);
  expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(
    23,
  );
  expect((await get("/dashboard", member)).json().counts.assigned).toBe(0);
  expect((await get("/dashboard", outsider)).statusCode).toBe(404);
  await admin.query("UPDATE app.projects SET archived_at=now() WHERE id=$1", [
    p,
  ]);
  expect((await get("/dashboard")).json().counts.overdue).toBe(0);
  expect((await get("/dashboard/tasks?kind=mine")).json().items).toEqual([]);
});
it("produces a complete portable snapshot with archived projects, scrubbed comments, and no credentials", async () => {
  const p = (await project({ templateId: "event" })).json().id;
  const issue = (
    await admin.query("SELECT id FROM app.issues WHERE project_id=$1 LIMIT 1", [
      p,
    ])
  ).rows[0].id;
  const c = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/issues/${issue}/comments`,
    headers: headers(),
    payload: { body: "Remove this sensitive draft", clientKey: randomUUID() },
  });
  expect(c.statusCode, c.body).toBe(201);
  await app.inject({
    method: "DELETE",
    url: `/api/v1/orgs/${org}/comments/${c.json().id}`,
    headers: { ...headers(), "if-match": '"1"' },
  });
  await admin.query("UPDATE app.projects SET archived_at=now() WHERE id=$1", [
    p,
  ]);
  const clientKey = randomUUID();
  const [a, b] = await Promise.all([
    requestExport(owner, clientKey),
    requestExport(owner, clientKey),
  ]);
  expect(a.statusCode, a.body).toBe(202);
  expect(b.json().id).toBe(a.json().id);
  const id = a.json().id;
  expect((await download(id)).statusCode).toBe(404);
  expect(await run(id)).toBe(true);
  const row = await exportRow(id);
  expect(row.state).toBe("ready");
  const content = objects.get(row.object_key)!.toString();
  const data = JSON.parse(content);
  expect(data.format).toBe("lira-export");
  expect(data.issues).toHaveLength(7);
  expect(data.projects[0].archived_at).not.toBeNull();
  expect(data.comments[0].body).toBe("");
  expect(data).toHaveProperty("attachmentManifest");
  expect(data).toHaveProperty("team_members");
  expect(data.boards).toHaveLength(1);
  expect(content).not.toContain("Remove this sensitive draft");
  expect(content).not.toContain(owner.email);
  expect(content).not.toContain(owner.sessionId);
  expect(content).not.toContain(otherOrg);
  expect(content).not.toContain("token_hash");
  expect((await download(id)).statusCode).toBe(200);
  expect((await download(id, member)).statusCode).toBe(403);
  expect((await requestExport(member)).statusCode).toBe(403);
  await admin.query("UPDATE app.memberships SET role='admin' WHERE id=$1", [
    memberId,
  ]);
  expect((await download(id, member)).statusCode).toBe(200);
  await admin.query("UPDATE app.memberships SET state='inactive' WHERE id=$1", [
    memberId,
  ]);
  expect((await download(id, member)).statusCode).toBe(404);
  expect(
    await withTenant(
      pool,
      outsider,
      otherOrg,
      async (tx) =>
        (await tx.query("SELECT id FROM app.exports WHERE id=$1", [id]))
          .rowCount,
    ),
  ).toBe(0);
});
it("keeps the first immutable snapshot when the upload succeeds but acknowledgment fails", async () => {
  const p = (await project()).json().id;
  const id = (await requestExport()).json().id;
  failRead = true;
  expect(await run(id)).toBe(false);
  const row = await exportRow(id);
  const original = objects.get(row.object_key)!.toString();
  await admin.query(
    "UPDATE app.projects SET name='Changed later' WHERE id=$1",
    [p],
  );
  failRead = false;
  expect(await run(id)).toBe(true);
  expect(objects.get(row.object_key)!.toString()).toBe(original);
  expect(JSON.parse(original).projects[0].name).toBe("Welcome week");
  expect((await exportRow(id)).state).toBe("ready");
});
it("rechecks the requester after I/O and enforces expiry and cleanup without losing failed cleanup records", async () => {
  await project();
  await admin.query("UPDATE app.memberships SET role='admin' WHERE id=$1", [
    memberId,
  ]);
  const id = (await requestExport(member)).json().id;
  onRead = async () => {
    await admin.query("UPDATE app.memberships SET role='member' WHERE id=$1", [
      memberId,
    ]);
  };
  expect(await run(id)).toBe(true);
  onRead = undefined;
  expect((await exportRow(id)).state).toBe("failed");
  expect((await download(id)).statusCode).toBe(404);
  const ready = (await requestExport()).json().id;
  expect(await run(ready)).toBe(true);
  await admin.query(
    "UPDATE app.exports SET expires_at=now()-interval '2 hours' WHERE id=$1",
    [ready],
  );
  expect((await download(ready)).statusCode).toBe(404);
  const key = (await exportRow(ready)).object_key;
  expect(await run(ready, "export.cleanup")).toBe(true);
  expect(objects.has(key)).toBe(false);
  expect(await run(ready, "export.cleanup")).toBe(true);
  await admin.query(
    "UPDATE app.outbox_jobs SET state='failed',created_at=now()-interval '40 days' WHERE type='export.cleanup' AND org_id=$1",
    [org],
  );
  await cleanupNotifications(admin, true);
  expect(
    (
      await admin.query(
        "SELECT id FROM app.outbox_jobs WHERE type='export.cleanup' AND org_id=$1",
        [org],
      )
    ).rowCount,
  ).toBe(2);
});
it("caps export requests and fails oversized snapshots explicitly without writing a partial file", async () => {
  const p = (await project()).json().id;
  const own = (
    await admin.query(
      "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
      [org, owner.id],
    )
  ).rows[0].id;
  await admin.query(
    "INSERT INTO app.issues(org_id,project_id,number,title,description,creator_membership_id,rank) SELECT $1,$2,n,'Large task',repeat('x',20000),$3,n*1024 FROM generate_series(1,270) n",
    [org, p, own],
  );
  const id = (await requestExport()).json().id;
  expect(await run(id)).toBe(true);
  const row = await exportRow(id);
  expect(row.state).toBe("failed");
  expect(row.failure).toContain("pilot limit");
  expect(objects.has(row.object_key)).toBe(false);
  expect((await requestExport()).statusCode).toBe(202);
  expect((await requestExport()).statusCode).toBe(429);
  await admin.query(
    "UPDATE app.exports SET created_at=now()-interval '2 days' WHERE org_id=$1",
    [org],
  );
  for (let n = 0; n < 2; n++)
    await admin.query(
      "INSERT INTO app.exports(org_id,requester_membership_id,client_key,object_key,created_at) VALUES($1,$2,$3,$4,now()-interval '2 days')",
      [org, own, randomUUID(), randomUUID()],
    );
  const capped = await requestExport();
  expect(capped.statusCode).toBe(429);
  expect(capped.json().code).toBe("export_cleanup_pending");
});
it("uses a private JSON-only export bucket and never overwrites an existing snapshot", async () => {
  const calls: RequestInit[] = [];
  const adapter = supabaseStorage(
    "https://fixture.supabase.co",
    "server-key",
    "lira-exports",
    async (_url, init) => {
      calls.push(init!);
      return Response.json(
        { error: "Duplicate", statusCode: "409" },
        { status: 409 },
      );
    },
    "exports",
  );
  const key = `${org}/${randomUUID()}/${randomUUID()}`;
  await adapter.writeJson(key, { test: true });
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.headers).not.toHaveProperty("x-upsert");
  await expect(adapter.signUpload(key)).rejects.toThrow("not allowed");
});
