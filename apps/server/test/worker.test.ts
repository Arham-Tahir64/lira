import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  assertWorkerRole,
  claimJob,
  finishJob,
  processJob,
  type ClaimedJob,
} from "../src/worker.js";
import { DeliveryError, resendAdapter } from "../src/email.js";
import { withTenant } from "../src/database.js";
import type { Identity } from "../src/identity.js";
const person = (name: string): Identity => ({
  id: randomUUID(),
  displayName: name,
  email: `${name}@example.test`,
  issuedAt: Math.floor(Date.now() / 1000),
  sessionId: randomUUID(),
});
const owner = person("owner"),
  recipient = person("recipient"),
  outsider = person("outsider");
const headers = (user = owner) => ({ authorization: `Bearer ${user.id}` });
let app: FastifyInstance,
  pool: pg.Pool,
  worker: pg.Pool,
  db: pg.Pool,
  org: string,
  otherOrg: string,
  project: string,
  member: string;
const options = {
  appUrl: "https://lira.example.test",
  emailFrom: "Lira <notify@example.test>",
};
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  worker = new pg.Pool({
    connectionString: process.env.TEST_WORKER_DATABASE_URL,
    max: 3,
  });
  db = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  app = await buildApp({
    pool,
    supabaseUrl: "http://localhost:54321",
    publicKey: "test-public",
    assignmentEmailEnabled: true,
    verifyIdentity: async (token) =>
      [owner, recipient, outsider].find((u) => u.id === token)!,
  });
  for (const user of [owner, recipient, outsider])
    await app.inject({ url: "/api/v1/me", headers: headers(user) });
  const create = async (user: Identity) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/orgs",
        headers: headers(user),
        payload: { name: "Worker club", slug: `worker-${randomUUID()}` },
      })
    ).json().id;
  org = await create(owner);
  otherOrg = await create(outsider);
  member = (
    await db.query(
      "INSERT INTO app.memberships(org_id,user_id,display_name,role) VALUES($1,$2,'Recipient','member') RETURNING id",
      [org, recipient.id],
    )
  ).rows[0].id;
  project = (
    await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/projects`,
      headers: headers(),
      payload: { name: "Worker project", key: "JOBS" },
    })
  ).json().id;
});
beforeEach(async () => {
  // Tests share only a disposable database; make earlier fixtures ineligible to claim.
  await db.query(
    "UPDATE app.outbox_jobs SET run_at=now()+interval '1 day',state='pending',lease_token=NULL,lease_until=NULL",
  );
  await db.query("UPDATE app.memberships SET state='active' WHERE id=$1", [
    member,
  ]);
  await db.query("DELETE FROM app.notification_preferences WHERE org_id=$1", [
    org,
  ]);
  await db.query("UPDATE app.projects SET archived_at=NULL WHERE id=$1", [
    project,
  ]);
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await worker?.end();
  await db?.end();
});
async function task() {
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/projects/${project}/issues`,
    headers: { ...headers(), "idempotency-key": randomUUID() },
    payload: { title: "Private task title", assigneeMembershipId: member },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function claim() {
  const j = await claimJob(worker);
  expect(j).toBeDefined();
  return j!;
}
async function enableEmail() {
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/api/v1/orgs/${org}/notification-preferences`,
        headers: headers(recipient),
        payload: { assignmentEmail: true },
      })
    ).statusCode,
  ).toBe(204);
}
async function reopen(job: ClaimedJob) {
  await db.query(
    "UPDATE app.outbox_jobs SET state='pending',run_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1",
    [job.id],
  );
  return claim();
}
it("requires separate non-owner worker credentials and exposes no unscoped domain rows", async () => {
  await expect(assertWorkerRole(worker)).resolves.toBeUndefined();
  await expect(assertWorkerRole(pool)).rejects.toThrow();
  await expect(assertWorkerRole(db)).rejects.toThrow();
  expect((await worker.query("SELECT * FROM app.issues")).rowCount).toBe(0);
  await expect(
    pool.query("SELECT * FROM app.claim_job()"),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(worker.query("SET ROLE app_scheduler")).rejects.toMatchObject({
    code: "42501",
  });
});
it("claims distinct jobs concurrently and fences an expired worker", async () => {
  await task();
  await task();
  const jobs = await Promise.all([claim(), claim()]);
  expect(jobs[0].id).not.toBe(jobs[1].id);
  await db.query(
    "UPDATE app.outbox_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [jobs[0].id],
  );
  const replacement = await claim();
  expect(replacement.id).toBe(jobs[0].id);
  expect(replacement.attempts).toBe(2);
  expect(await finishJob(worker, jobs[0])).toBe(false);
  expect(await finishJob(worker, replacement)).toBe(true);
});
it("deduplicates recipient-only in-app notifications and isolates reads and marks", async () => {
  await task();
  const job = await claim();
  expect(await processJob(worker, job, options)).toBe(true);
  expect(await processJob(worker, await reopen(job), options)).toBe(true);
  const rows = (
    await db.query(
      "SELECT id FROM app.notifications WHERE event_id=(SELECT event_id FROM app.outbox_jobs WHERE id=$1)",
      [job.id],
    )
  ).rows;
  expect(rows).toHaveLength(1);
  const url = `/api/v1/orgs/${org}/notifications`;
  expect((await app.inject({ url, headers: headers() })).json().items).toEqual(
    [],
  );
  expect(
    (await app.inject({ url, headers: headers(outsider) })).statusCode,
  ).toBe(404);
  const mark = (user: Identity) =>
    app.inject({
      method: "PATCH",
      url: `${url}/${rows[0].id}`,
      headers: headers(user),
      payload: { read: true },
    });
  expect((await mark(owner)).statusCode).toBe(404);
  expect((await mark(recipient)).statusCode).toBe(204);
  await withTenant(pool, owner, org, async (tx) =>
    expect((await tx.query("SELECT * FROM app.notifications")).rowCount).toBe(
      0,
    ),
  );
});
it("uses the job tenant even if payload references another tenant", async () => {
  await task();
  const job = await claim();
  expect(await processJob(worker, { ...job, org_id: otherOrg }, options)).toBe(
    false,
  );
  expect(
    (
      await db.query(
        "SELECT * FROM app.notifications WHERE event_id=(SELECT event_id FROM app.outbox_jobs WHERE id=$1)",
        [job.id],
      )
    ).rowCount,
  ).toBe(0);
});
it("rechecks current membership and assignment before delivery", async () => {
  const issue = await task();
  const job = await claim();
  await db.query(
    "UPDATE app.issues SET assignee_membership_id=NULL WHERE id=$1",
    [issue.id],
  );
  expect(await processJob(worker, job, options)).toBe(true);
  expect(
    (
      await db.query("SELECT * FROM app.notifications WHERE issue_id=$1", [
        issue.id,
      ])
    ).rowCount,
  ).toBe(0);
  const second = await task();
  const job2 = await claim();
  await db.query("UPDATE app.memberships SET state='inactive' WHERE id=$1", [
    member,
  ]);
  expect(await processJob(worker, job2, options)).toBe(true);
  expect(
    (
      await db.query("SELECT * FROM app.notifications WHERE issue_id=$1", [
        second.id,
      ])
    ).rowCount,
  ).toBe(0);
});
it("commits in-app delivery before email and keeps a stable idempotent request across retry", async () => {
  await enableEmail();
  const issue = await task();
  const job = await claim();
  const send = vi.fn(async () => {
    expect(
      (
        await db.query("SELECT * FROM app.notifications WHERE issue_id=$1", [
          issue.id,
        ])
      ).rowCount,
    ).toBe(1);
    throw new DeliveryError("email_retry");
  });
  expect(await processJob(worker, job, { ...options, sendEmail: send })).toBe(
    false,
  );
  const second = vi.fn(async () => {});
  expect(
    await processJob(worker, await reopen(job), {
      ...options,
      appUrl: "https://changed.example.test",
      sendEmail: second,
    }),
  ).toBe(true);
  expect(second.mock.calls[0]).toEqual(send.mock.calls[0]);
  expect(JSON.stringify(second.mock.calls)).not.toContain("Private task title");
  const duplicate = vi.fn(async () => {});
  await processJob(worker, await reopen(job), {
    ...options,
    sendEmail: duplicate,
  });
  expect(duplicate).not.toHaveBeenCalled();
});
it("preserves the in-app notification when email configuration is missing", async () => {
  await enableEmail();
  const issue = await task();
  const job = await claim();
  expect(await processJob(worker, job, { appUrl: options.appUrl })).toBe(false);
  expect(
    (
      await db.query("SELECT * FROM app.notifications WHERE issue_id=$1", [
        issue.id,
      ])
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await db.query(
        "SELECT last_error,state FROM app.outbox_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0],
  ).toEqual({ last_error: "email_unavailable", state: "pending" });
});
it("honors opt-out on retry and never sends old backlog email", async () => {
  await enableEmail();
  await task();
  const job = await claim();
  await processJob(worker, job, {
    ...options,
    sendEmail: async () => {
      throw new DeliveryError("email_retry");
    },
  });
  await app.inject({
    method: "PUT",
    url: `/api/v1/orgs/${org}/notification-preferences`,
    headers: headers(recipient),
    payload: { assignmentEmail: false },
  });
  const send = vi.fn(async () => {});
  await processJob(worker, await reopen(job), { ...options, sendEmail: send });
  expect(send).not.toHaveBeenCalled();
  await enableEmail();
  await task();
  const old = await claim();
  await db.query(
    "UPDATE app.activity_events SET created_at=now()-interval '2 days' WHERE id=(SELECT event_id FROM app.outbox_jobs WHERE id=$1)",
    [old.id],
  );
  await processJob(worker, old, { ...options, sendEmail: send });
  expect(send).not.toHaveBeenCalled();
});
it("backs off failures and places exhausted leases in visible failed state", async () => {
  await task();
  const job = await claim();
  expect(await finishJob(worker, job, "processing_failed")).toBe(true);
  const row = (
    await db.query(
      "SELECT state,run_at>now() AS delayed FROM app.outbox_jobs WHERE id=$1",
      [job.id],
    )
  ).rows[0];
  expect(row).toEqual({ state: "pending", delayed: true });
  await db.query(
    "UPDATE app.outbox_jobs SET state='processing',attempts=8,lease_until=now()-interval '1 second' WHERE id=$1",
    [job.id],
  );
  await claimJob(worker);
  const status = await app.inject({
    url: `/api/v1/orgs/${org}/jobs/status`,
    headers: headers(),
  });
  expect(
    status.json().failed.some((r: { id: string }) => r.id === job.id),
  ).toBe(true);
  expect(
    (
      await app.inject({
        url: `/api/v1/orgs/${org}/jobs/status`,
        headers: headers(recipient),
      })
    ).statusCode,
  ).toBe(403);
});
it("handles provider idempotency and sanitizes network and rejection failures", async () => {
  const transport = vi.fn<typeof fetch>(
    async () => new Response("{}", { status: 200 }),
  );
  const send = resendAdapter("test-secret", transport);
  const request = {
    from: "a@example.test",
    to: ["b@example.test"],
    subject: "Assignment",
    text: "Sign in",
  };
  await send(request, "key-1");
  expect(
    new Headers(transport.mock.calls[0]![1]!.headers).get("Idempotency-Key"),
  ).toBe("key-1");
  const reject = resendAdapter(
    "test-secret",
    async () => new Response("private provider details", { status: 422 }),
  );
  await expect(reject(request, "key-2")).rejects.toMatchObject({
    code: "email_rejected",
  });
  const retry = resendAdapter("test-secret", async () => {
    throw new Error("secret");
  });
  await expect(retry(request, "key-3")).rejects.toThrow("email_retry");
});
it("reserves delivery budget once per job and defers new email after the daily cap", async () => {
  await enableEmail();
  await task();
  const first = await claim();
  const used = Number(
    (
      await db.query(
        "SELECT count(*) FROM app.email_reservations WHERE day=CURRENT_DATE",
      )
    ).rows[0].count,
  );
  const send = vi.fn(async () => {});
  expect(
    await processJob(worker, first, {
      ...options,
      emailDailyLimit: used + 1,
      sendEmail: send,
    }),
  ).toBe(true);
  await task();
  const second = await claim();
  expect(
    await processJob(worker, second, {
      ...options,
      emailDailyLimit: used + 1,
      sendEmail: send,
    }),
  ).toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  const row = (
    await db.query(
      "SELECT last_error,run_at>date_trunc('day',now())+interval '1 day' AS tomorrow FROM app.outbox_jobs WHERE id=$1",
      [second.id],
    )
  ).rows[0];
  expect(row).toEqual({ last_error: "email_budget", tomorrow: true });
});

it("retention defaults to a preview and preserves pending jobs", async () => {
  const { cleanupNotifications } =
    await import("../../../scripts/notification-retention.js");
  const old = await task();
  const job = await claim();
  await processJob(worker, job, options);
  await db.query(
    "UPDATE app.notifications SET created_at=now()-interval '91 days' WHERE issue_id=$1",
    [old.id],
  );
  await db.query(
    "UPDATE app.outbox_jobs SET completed_at=now()-interval '8 days' WHERE id=$1",
    [job.id],
  );
  await task();
  const pending = (
    await db.query(
      "SELECT id FROM app.outbox_jobs WHERE org_id=$1 AND state='pending' AND run_at<=now() ORDER BY created_at DESC LIMIT 1",
      [org],
    )
  ).rows[0].id;
  await db.query(
    "UPDATE app.outbox_jobs SET created_at=now()-interval '100 days' WHERE id=$1",
    [pending],
  );
  const preview = await cleanupNotifications(db);
  expect(
    preview.find((r) => r.table === "notifications")!.count,
  ).toBeGreaterThan(0);
  expect(
    (
      await db.query("SELECT * FROM app.notifications WHERE issue_id=$1", [
        old.id,
      ])
    ).rowCount,
  ).toBe(1);
  await cleanupNotifications(db, true);
  expect(
    (
      await db.query("SELECT * FROM app.notifications WHERE issue_id=$1", [
        old.id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (await db.query("SELECT * FROM app.outbox_jobs WHERE id=$1", [pending]))
      .rowCount,
  ).toBe(1);
});
