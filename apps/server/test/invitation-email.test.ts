import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { claimJob, processJob } from "../src/worker.js";
import {
  encryptInvitation,
  decryptInvitation,
  invitationMailFromEnvironment,
} from "../src/invitation-email.js";
import { DeliveryError } from "../src/email.js";
import { withTenant } from "../src/database.js";
import { cleanupNotifications } from "../../../scripts/notification-retention.js";
const owner = {
  id: randomUUID(),
  displayName: "Inviter",
  email: "inviter@example.test",
  issuedAt: Math.floor(Date.now() / 1000),
  sessionId: randomUUID(),
};
const config = {
  key: randomBytes(32),
  from: "Lira <invites@example.test>",
  appUrl: "https://lira.example.test",
};
let app: FastifyInstance,
  pool: pg.Pool,
  worker: pg.Pool,
  db: pg.Pool,
  org: string;
const identities = [owner];
const headers = { authorization: `Bearer ${owner.id}` };
beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  worker = new pg.Pool({
    connectionString: process.env.TEST_WORKER_DATABASE_URL,
  });
  db = new pg.Pool({ connectionString: process.env.TEST_ADMIN_DATABASE_URL });
  app = await buildApp({
    pool,
    supabaseUrl: "http://localhost:54321",
    publicKey: "test-public",
    invitationMail: config,
    verifyIdentity: async (token) => identities.find((u) => u.id === token)!,
  });
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/orgs",
    headers,
    payload: { name: "Mail club", slug: `mail-${randomUUID()}` },
  });
  expect(r.statusCode, r.body).toBe(201);
  org = r.json().id;
});
beforeEach(async () => {
  await db.query(
    "UPDATE app.outbox_jobs SET run_at=now()+interval '2 days',state='pending',lease_token=NULL,lease_until=NULL",
  );
  await db.query(
    "UPDATE app.memberships SET role='owner',state='active' WHERE org_id=$1 AND user_id=$2",
    [org, owner.id],
  );
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await worker?.end();
  await db?.end();
  vi.unstubAllEnvs();
});
async function invite() {
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/invitations`,
    headers,
    payload: { email: `${randomUUID()}@example.test`, role: "member" },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function intent(id: string) {
  return (
    await db.query(
      "SELECT * FROM app.invitation_emails WHERE invitation_id=$1",
      [id],
    )
  ).rows[0];
}
async function run(
  id: string,
  send = vi.fn().mockResolvedValue(undefined),
  mail: typeof config | null = config,
  type = "invitation.email",
  limit = 100,
) {
  await db.query(
    "UPDATE app.outbox_jobs SET run_at=now(),state='pending',lease_token=NULL,lease_until=NULL WHERE org_id=$1 AND type=$2 AND payload->>'invitationId'=$3",
    [org, type, id],
  );
  const job = await claimJob(worker);
  expect(job).toBeDefined();
  await processJob(worker, job!, {
    appUrl: config.appUrl,
    invitationMail: mail ?? undefined,
    sendEmail: send,
    emailDailyLimit: limit,
  });
  return job!;
}
it("queues encrypted content atomically, restricts ciphertext reads, and exposes status only", async () => {
  const i = await invite(),
    e = await intent(i.id);
  expect(i.email_status).toBe("queued");
  expect(e.encrypted_payload).not.toContain(i.token);
  expect(e.encrypted_payload).not.toContain(i.email);
  expect(
    decryptInvitation(e.encrypted_payload, config.key, org, i.id).text,
  ).toContain(`#invite=${i.token}`);
  await expect(
    withTenant(pool, owner, org, (tx) =>
      tx.query("SELECT encrypted_payload FROM app.invitation_emails"),
    ),
  ).rejects.toMatchObject({ code: "42501" });
  const c = await worker.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.org_id',$1,true)", [randomUUID()]);
    expect((await c.query("SELECT * FROM app.invitation_emails")).rows).toEqual(
      [],
    );
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
  const jobs = (
    await db.query(
      "SELECT payload FROM app.outbox_jobs WHERE org_id=$1 AND payload->>'invitationId'=$2",
      [org, i.id],
    )
  ).rows;
  expect(jobs).toHaveLength(2);
  expect(JSON.stringify(jobs)).not.toContain(i.token);
  const list = await app.inject({
    url: `/api/v1/orgs/${org}/invitations`,
    headers,
  });
  expect(list.statusCode, list.body).toBe(200);
  expect(list.body).not.toContain(e.encrypted_payload);
  expect(
    list.json().find((x: { id: string }) => x.id === i.id).email_status,
  ).toBe("queued");
});
it("sends the bound link once and clears recoverable token material", async () => {
  const i = await invite(),
    send = vi.fn().mockResolvedValue(undefined);
  await run(i.id, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({
    to: [i.email],
    from: config.from,
    text: expect.stringContaining(`#invite=${i.token}`),
  });
  expect(await intent(i.id)).toMatchObject({
    state: "sent",
    encrypted_payload: null,
  });
  await run(i.id, send);
  expect(send).toHaveBeenCalledTimes(1);
});
it("retries uncertain provider outcomes with the identical body and idempotency key", async () => {
  const i = await invite(),
    send = vi
      .fn()
      .mockRejectedValueOnce(new DeliveryError("email_retry"))
      .mockResolvedValue(undefined);
  await run(i.id, send);
  expect((await intent(i.id)).state).toBe("queued");
  await run(i.id, send);
  expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
  expect((await intent(i.id)).state).toBe("sent");
});
it("revocation scrubs queued content before the worker can send", async () => {
  const i = await invite();
  const r = await app.inject({
    method: "DELETE",
    url: `/api/v1/orgs/${org}/invitations/${i.id}`,
    headers,
  });
  expect(r.statusCode, r.body).toBe(204);
  expect(await intent(i.id)).toMatchObject({
    state: "cancelled",
    encrypted_payload: null,
  });
  const send = vi.fn();
  await run(i.id, send);
  expect(send).not.toHaveBeenCalled();
});
it.each(["accepted", "expired", "offboarded", "demoted"])(
  "does not send when invitation authority is %s",
  async (reason) => {
    const i = await invite();
    if (reason === "accepted")
      await db.query(
        "UPDATE app.invitations SET accepted_at=now() WHERE id=$1",
        [i.id],
      );
    if (reason === "expired")
      await db.query(
        "UPDATE app.invitations SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second' WHERE id=$1",
        [i.id],
      );
    if (reason === "offboarded" || reason === "demoted") {
      // Keep a second owner so the database's last-owner guard remains satisfied.
      const id = randomUUID();
      await db.query(
        "INSERT INTO app.users(id,auth_subject,display_name,verified_email) VALUES($1,$1,'Backup owner',$2)",
        [id, `${id}@example.test`],
      );
      await db.query(
        "INSERT INTO app.memberships(org_id,user_id,display_name,role) VALUES($1,$2,'Backup owner','owner')",
        [org, id],
      );
      await db.query(
        reason === "offboarded"
          ? "UPDATE app.memberships SET state='inactive' WHERE org_id=$1 AND user_id=$2"
          : "UPDATE app.memberships SET role='member' WHERE org_id=$1 AND user_id=$2",
        [org, owner.id],
      );
    }
    const send = vi.fn();
    await run(i.id, send);
    expect(send).not.toHaveBeenCalled();
    expect(await intent(i.id)).toMatchObject({
      state: "cancelled",
      encrypted_payload: null,
    });
  },
);
it("honors the shared daily budget and terminal provider rejections", async () => {
  const i = await invite(),
    send = vi.fn();
  await run(i.id, send, config, "invitation.email", 0);
  expect(send).not.toHaveBeenCalled();
  send.mockRejectedValue(new DeliveryError("email_rejected"));
  await run(i.id, send);
  expect(await intent(i.id)).toMatchObject({
    state: "failed",
    encrypted_payload: null,
  });
});
it("expires email content independently of the seven-day invitation", async () => {
  const i = await invite();
  await db.query(
    "UPDATE app.invitation_emails SET expires_at=now()-interval '1 second' WHERE invitation_id=$1",
    [i.id],
  );
  const send = vi.fn();
  await run(i.id, send, config, "invitation.email_expire");
  expect(send).not.toHaveBeenCalled();
  expect(await intent(i.id)).toMatchObject({
    state: "expired",
    encrypted_payload: null,
  });
  expect(
    (
      await db.query(
        "SELECT expires_at>now() AS valid FROM app.invitations WHERE id=$1",
        [i.id],
      )
    ).rows[0].valid,
  ).toBe(true);
});
it("maintenance previews then scrubs expired payloads if workers were offline", async () => {
  const i = await invite();
  await db.query(
    "UPDATE app.invitation_emails SET expires_at=now()-interval '1 second' WHERE invitation_id=$1",
    [i.id],
  );
  expect(await cleanupNotifications(db)).toContainEqual({
    table: "invitation_email_payloads",
    count: 1,
  });
  expect((await intent(i.id)).encrypted_payload).not.toBeNull();
  await cleanupNotifications(db, true);
  expect((await intent(i.id)).encrypted_payload).toBeNull();
});
it("authenticates tenant binding, rejects tampering, and validates opt-in configuration", () => {
  const request = {
    from: config.from,
    to: ["test@example.test"],
    subject: "Invite",
    text: "secret link",
  };
  const encrypted = encryptInvitation(request, config.key, "org", "invite");
  expect(() =>
    decryptInvitation(encrypted, config.key, "other", "invite"),
  ).toThrow("email_unavailable");
  expect(() =>
    decryptInvitation(
      encrypted.slice(0, -5) + "xxxxx",
      config.key,
      "org",
      "invite",
    ),
  ).toThrow("email_unavailable");
  vi.stubEnv("INVITATION_EMAIL_ENABLED", "false");
  expect(invitationMailFromEnvironment()).toBeUndefined();
  vi.stubEnv("INVITATION_EMAIL_ENABLED", "true");
  vi.stubEnv("INVITATION_EMAIL_ENCRYPTION_KEY", config.key.toString("base64"));
  vi.stubEnv("EMAIL_FROM", config.from);
  vi.stubEnv("APP_URL", config.appUrl);
  expect(invitationMailFromEnvironment()).toEqual(config);
  vi.stubEnv("APP_URL", "http://untrusted.example");
  expect(invitationMailFromEnvironment).toThrow();
  vi.unstubAllEnvs();
});

it("acceptance through the API clears queued mail in the same transaction", async () => {
  const i = await invite();
  const recipient = {
    ...owner,
    id: randomUUID(),
    sessionId: randomUUID(),
    email: i.email,
  };
  identities.push(recipient);
  const r = await app.inject({
    method: "POST",
    url: "/api/v1/invitations/accept",
    headers: { authorization: `Bearer ${recipient.id}` },
    payload: { token: i.token },
  });
  expect(r.statusCode, r.body).toBe(201);
  expect(await intent(i.id)).toMatchObject({
    state: "cancelled",
    encrypted_payload: null,
  });
});
it("disabled delivery cancels queued content and a wrong key never sends", async () => {
  const i = await invite(),
    send = vi.fn();
  await run(i.id, send, { ...config, key: randomBytes(32) });
  expect(send).not.toHaveBeenCalled();
  expect((await intent(i.id)).state).toBe("queued");
  await run(i.id, send, null);
  expect(send).not.toHaveBeenCalled();
  expect(await intent(i.id)).toMatchObject({
    state: "cancelled",
    encrypted_payload: null,
  });
});
