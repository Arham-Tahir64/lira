import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { cleanupNotifications } from "../../../scripts/notification-retention.js";
import { buildApp } from "../src/app.js";
import { withTenant } from "../src/database.js";
import { processJob, type ClaimedJob } from "../src/worker.js";
import {
  MAX_FILE_BYTES,
  WORKSPACE_BYTES,
  validFile,
  supabaseStorage,
  type ObjectStorage,
} from "../src/storage.js";
import type { Identity } from "../src/identity.js";
const identity = (name: string): Identity => ({
  id: randomUUID(),
  displayName: name,
  email: `${name}@example.test`,
  sessionId: randomUUID(),
  issuedAt: Math.floor(Date.now() / 1000),
  authenticatedAt: Math.floor(Date.now() / 1000),
});
const owner = identity("owner"),
  member = identity("member"),
  outsider = identity("outsider");
const headers = (who = owner) => ({ authorization: `Bearer ${who.id}` });
const bytes = Buffer.from("Club handoff notes\n");
const checksum = createHash("sha256").update(bytes).digest("hex");
const objects = new Map<string, Buffer>();
const signed: string[] = [];
let failRemoval = false;
const storage: ObjectStorage = {
  async signUpload(key) {
    signed.push(key);
    return `https://storage.example.test/${key}?token=fixture`;
  },
  async read(key) {
    const result = objects.get(key);
    if (!result) throw new Error("not_found");
    return result;
  },
  async signDownload(key) {
    signed.push(key);
    return `https://storage.example.test/${key}?download=file&token=fixture`;
  },
  async remove(key) {
    if (failRemoval) throw new Error("provider_unavailable");
    objects.delete(key);
  },
};
let app: FastifyInstance, pool: pg.Pool, admin: pg.Pool, worker: pg.Pool;
let org: string,
  project: string,
  task: string,
  memberId: string,
  otherOrg: string,
  otherProject: string,
  otherTask: string;
const pilotOrgs = new Set<string>();
const request = (id: string, action: string, who = owner) =>
  app.inject({
    method: action === "delete" ? "DELETE" : "POST",
    url: `/api/v1/orgs/${org}/attachments/${id}${action === "delete" ? "" : `/${action}`}`,
    headers: headers(who),
  });
async function reserve(extra: Record<string, unknown> = {}, who = owner) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${org}/issues/${task}/attachments`,
    headers: headers(who),
    payload: {
      name: "handoff.txt",
      mediaType: "text/plain",
      bytes: bytes.length,
      checksum,
      clientKey: randomUUID(),
      ...extra,
    },
  });
}
async function row(id: string) {
  return (await admin.query("SELECT * FROM app.attachments WHERE id=$1", [id]))
    .rows[0];
}
async function run(id: string, type: string) {
  const job = (
    await admin.query(
      "UPDATE app.outbox_jobs SET state='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE org_id=$1 AND type=$2 AND payload->>'attachmentId'=$3 RETURNING id,org_id,lease_token,attempts",
      [org, type, id],
    )
  ).rows[0] as ClaimedJob;
  expect(job).toBeDefined();
  return processJob(worker, job, {
    appUrl: "https://lira.example.test",
    attachments: { storage, pilotOrgs },
  });
}
beforeAll(async () => {
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
  app = await buildApp({
    pool,
    supabaseUrl: "https://fixture.supabase.co",
    publicKey: "fixture",
    attachments: { storage, pilotOrgs },
    verifyIdentity: async (token) =>
      [owner, member, outsider].find((x) => x.id === token)!,
  });
  for (const who of [owner, member, outsider])
    await app.inject({ url: "/api/v1/me", headers: headers(who) });
  async function setup(who: Identity) {
    const o = await app.inject({
      method: "POST",
      url: "/api/v1/orgs",
      headers: headers(who),
      payload: {
        name: "Files club",
        slug: `files-${randomUUID().slice(0, 8)}`,
      },
    });
    expect(o.statusCode, o.body).toBe(201);
    const org = o.json().id;
    const p = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/projects`,
      headers: headers(who),
      payload: { name: "Handoff", key: "FILE" },
    });
    expect(p.statusCode, p.body).toBe(201);
    const project = p.json().id;
    const i = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/projects/${project}/issues`,
      headers: { ...headers(who), "idempotency-key": randomUUID() },
      payload: { title: "Notes" },
    });
    expect(i.statusCode, i.body).toBe(201);
    return [org, project, i.json().id] as const;
  }
  [org, project, task] = await setup(owner);
  [otherOrg, otherProject, otherTask] = await setup(outsider);
  pilotOrgs.add(org);
  memberId = (
    await admin.query(
      "INSERT INTO app.memberships(org_id,user_id,role) VALUES($1,$2,'member') RETURNING id",
      [org, member.id],
    )
  ).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await Promise.all([pool?.end(), admin?.end(), worker?.end()]);
});
describe("attachment lifecycle with real tenant SQL and a private storage fixture", () => {
  it("reserves idempotently, validates in worker, and authorizes downloads freshly", async () => {
    const clientKey = randomUUID();
    const results = await Promise.all([
      reserve({ clientKey }),
      reserve({ clientKey }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([201, 201]);
    const id = results[0]!.json().id;
    expect(results[1]!.json().id).toBe(id);
    expect((await reserve({ clientKey, name: "other.txt" })).statusCode).toBe(
      409,
    );
    expect((await request(id, "download")).statusCode).toBe(409);
    const r = await row(id);
    expect(r.object_key).toBe(`${org}/${project}/${id}`);
    expect(r.charged_bytes).toBe(MAX_FILE_BYTES);
    objects.set(r.object_key, bytes);
    expect((await request(id, "complete")).statusCode).toBe(200);
    expect((await request(id, "complete")).statusCode).toBe(200);
    expect((await request(id, "download")).statusCode).toBe(409);
    expect(await run(id, "attachment.validate")).toBe(true);
    expect((await row(id)).state).toBe("ready");
    expect((await row(id)).charged_bytes).toBe(bytes.length);
    expect((await request(id, "download", member)).statusCode).toBe(200);
    await admin.query(
      "UPDATE app.memberships SET state='inactive' WHERE id=$1",
      [memberId],
    );
    const before = signed.length;
    expect((await request(id, "download", member)).statusCode).toBe(404);
    expect(signed.length).toBe(before);
    await admin.query("UPDATE app.memberships SET state='active' WHERE id=$1", [
      memberId,
    ]);
    expect((await request(id, "delete", member)).statusCode).toBe(403);
    expect((await request(id, "delete")).statusCode).toBe(204);
    expect((await request(id, "download")).statusCode).toBe(409);
    expect(objects.has(r.object_key)).toBe(true);
    expect(await run(id, "attachment.remove")).toBe(false);
    expect(objects.has(r.object_key)).toBe(true);
    await admin.query(
      "UPDATE app.attachments SET delete_after=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    failRemoval = true;
    expect(await run(id, "attachment.remove")).toBe(false);
    expect((await row(id)).state).toBe("deleting");
    failRemoval = false;
    expect(await run(id, "attachment.remove")).toBe(true);
    expect(await run(id, "attachment.remove")).toBe(true);
    expect((await row(id)).state).toBe("deleted");
    expect(objects.has(r.object_key)).toBe(false);
  });
  it("rejects wrong-tenant references, unsafe names/types, and inactive pilot access", async () => {
    const calls = signed.length;
    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/issues/${otherTask}/attachments`,
      headers: headers(),
      payload: {
        name: "notes.txt",
        mediaType: "text/plain",
        bytes: bytes.length,
        checksum,
        clientKey: randomUUID(),
      },
    });
    expect(wrong.statusCode).toBe(404);
    expect((await reserve({ name: "../notes.txt" })).statusCode).toBe(400);
    expect((await reserve({ mediaType: "text/html" })).statusCode).toBe(400);
    expect((await reserve({ name: "script.html" })).statusCode).toBe(400);
    expect((await reserve({ bytes: MAX_FILE_BYTES + 1 })).statusCode).toBe(400);
    pilotOrgs.delete(org);
    expect((await reserve()).statusCode).toBe(403);
    pilotOrgs.add(org);
    expect(signed.length).toBe(calls);
    const id = (await reserve()).json().id;
    expect((await request(id, "complete", member)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: `/api/v1/orgs/${otherOrg}/issues/${task}/attachments`,
          headers: headers(outsider),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/orgs/${otherOrg}/attachments/${id}/download`,
          headers: headers(outsider),
        })
      ).statusCode,
    ).toBe(404);
    await expect(
      withTenant(pool, owner, org, (tx) =>
        tx.query("UPDATE app.attachments SET project_id=$2 WHERE id=$1", [
          id,
          otherProject,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      await withTenant(
        pool,
        outsider,
        otherOrg,
        async (tx) =>
          (await tx.query("SELECT id FROM app.attachments WHERE id=$1", [id]))
            .rowCount,
      ),
    ).toBe(0);
  });
  it("quarantines checksum/signature failures and cleans expired reservations", async () => {
    const id = (await reserve()).json().id;
    const r = await row(id);
    objects.set(r.object_key, Buffer.from("<script>bad</script>"));
    await request(id, "complete");
    expect(await run(id, "attachment.validate")).toBe(true);
    expect((await row(id)).state).toBe("deleting");
    expect((await request(id, "download")).statusCode).toBe(409);
    await admin.query(
      "UPDATE app.attachments SET delete_after=now()-interval '1 second' WHERE id=$1",
      [id],
    );
    expect(await run(id, "attachment.cleanup")).toBe(true);
    expect(objects.has(r.object_key)).toBe(false);
    const expired = (await reserve()).json().id;
    await admin.query(
      "UPDATE app.attachments SET expires_at=now()-interval '1 minute',delete_after=now()-interval '1 minute' WHERE id=$1",
      [expired],
    );
    expect((await request(expired, "complete")).statusCode).toBe(409);
    expect(await run(expired, "attachment.cleanup")).toBe(true);
    expect((await row(expired)).state).toBe("deleted");
  });
  it("does not publish a file deleted while the worker reads it", async () => {
    const id = (await reserve()).json().id;
    objects.set((await row(id)).object_key, bytes);
    await request(id, "complete");
    const read = storage.read;
    storage.read = async (key) => {
      expect((await request(id, "delete")).statusCode).toBe(204);
      return read(key);
    };
    try {
      expect(await run(id, "attachment.validate")).toBe(true);
    } finally {
      storage.read = read;
    }
    expect((await row(id)).state).toBe("deleting");
  });
  it("blocks writes to archived projects but retains downloads of validated files", async () => {
    const id = (await reserve()).json().id;
    objects.set((await row(id)).object_key, bytes);
    await request(id, "complete");
    await run(id, "attachment.validate");
    await admin.query("UPDATE app.projects SET archived_at=now() WHERE id=$1", [
      project,
    ]);
    expect((await reserve()).statusCode).toBe(409);
    expect((await request(id, "delete")).statusCode).toBe(409);
    expect((await request(id, "download")).statusCode).toBe(200);
    await admin.query("UPDATE app.projects SET archived_at=NULL WHERE id=$1", [
      project,
    ]);
  });
  it("rejects a stale validation lease and preserves failed cleanup jobs during retention", async () => {
    const id = (await reserve()).json().id;
    objects.set((await row(id)).object_key, bytes);
    await request(id, "complete");
    const read = storage.read;
    storage.read = async (key) => {
      await admin.query(
        "UPDATE app.outbox_jobs SET lease_until=now()-interval '1 second' WHERE org_id=$1 AND type='attachment.validate' AND payload->>'attachmentId'=$2",
        [org, id],
      );
      return read(key);
    };
    try {
      expect(await run(id, "attachment.validate")).toBe(false);
    } finally {
      storage.read = read;
    }
    expect((await row(id)).state).toBe("quarantined");
    expect(await run(id, "attachment.validate")).toBe(true);
    await request(id, "delete");
    await admin.query(
      "UPDATE app.outbox_jobs SET state='failed',created_at=now()-interval '40 days' WHERE org_id=$1 AND type='attachment.remove' AND payload->>'attachmentId'=$2",
      [org, id],
    );
    await cleanupNotifications(admin, true);
    expect(
      (
        await admin.query(
          "SELECT id FROM app.outbox_jobs WHERE org_id=$1 AND type='attachment.remove' AND payload->>'attachmentId'=$2",
          [org, id],
        )
      ).rowCount,
    ).toBe(1);
  });
  it("serializes concurrent reservations against the full provider-size budget", async () => {
    // Seed nearly-full retained storage across many tasks; actual reservations still use the restricted API role.
    const uploader = (
      await admin.query(
        "SELECT id FROM app.memberships WHERE org_id=$1 AND user_id=$2",
        [org, owner.id],
      )
    ).rows[0].id;
    await admin.query(
      "UPDATE app.attachments SET state='deleted' WHERE org_id=$1",
      [org],
    );
    for (let n = 0; n < 101; n++)
      await admin.query(
        "INSERT INTO app.attachments(org_id,project_id,issue_id,uploader_membership_id,client_key,object_key,name,media_type,bytes,checksum,state) VALUES($1,$2,$3,$4,$5,$6,'fixture.txt','text/plain',$7,$8,'ready')",
        [
          org,
          project,
          task,
          uploader,
          randomUUID(),
          randomUUID(),
          n === 100 ? Math.floor(MAX_FILE_BYTES / 2) : MAX_FILE_BYTES,
          checksum,
        ],
      );
    await admin.query(
      "UPDATE app.attachments SET charged_bytes=bytes WHERE org_id=$1",
      [org],
    );
    // Keep per-task count out of this quota test by using a new issue.
    const i = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${org}/projects/${project}/issues`,
      headers: { ...headers(), "idempotency-key": randomUUID() },
      payload: { title: "Quota" },
    });
    task = i.json().id;
    const result = await Promise.all([reserve(), reserve()]);
    expect(result.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const total = (
      await admin.query(
        "SELECT sum(charged_bytes)::bigint AS bytes FROM app.attachments WHERE org_id=$1 AND state<>'deleted'",
        [org],
      )
    ).rows[0].bytes;
    expect(Number(total)).toBeLessThanOrEqual(WORKSPACE_BYTES);
  });
});
describe("storage content boundary", () => {
  it("checks checksum, actual byte count, and allowed file signatures", () => {
    const check = (b: Buffer, t: string) =>
      validFile(b, t, b.length, createHash("sha256").update(b).digest("hex"));
    expect(check(bytes, "text/plain")).toBe(true);
    expect(validFile(bytes, "text/plain", 1, checksum)).toBe(false);
    expect(check(Buffer.from("<html>attack</html>"), "text/plain")).toBe(false);
    expect(check(Buffer.from([0, 255]), "text/plain")).toBe(false);
    expect(check(Buffer.from("%PDF-1.7\n%%EOF"), "application/pdf")).toBe(true);
    expect(check(bytes, "application/pdf")).toBe(false);
    expect(
      check(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"),
    ).toBe(true);
    expect(check(Buffer.from([255, 216, 255, 217]), "image/jpeg")).toBe(true);
  });
  it("bounds streamed reads and never leaks provider errors", async () => {
    const key = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const adapter = supabaseStorage(
      "https://storage.example.test",
      "server-only",
      "lira-attachments",
      async () => new Response(new Uint8Array(MAX_FILE_BYTES + 1)),
    );
    await expect(adapter.read(key)).rejects.toThrow("oversized_object");
    const unavailable = supabaseStorage(
      "https://storage.example.test",
      "server-only",
      "lira-attachments",
      async () => new Response("sensitive provider detail", { status: 503 }),
    );
    await expect(unavailable.signUpload(key)).rejects.toThrow(
      "storage_unavailable",
    );
  });
  it("enforces private bucket configuration and scoped signed transfer requests", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/bucket/"))
        return Response.json({
          public: false,
          file_size_limit: MAX_FILE_BYTES,
          allowed_mime_types: ["text/plain"],
        });
      if (url.includes("/upload/sign/"))
        return Response.json({
          url: "/object/upload/sign/bucket/key?token=fixture",
        });
      return Response.json({
        signedURL: "/object/sign/bucket/key?token=fixture",
      });
    };
    const adapter = supabaseStorage(
      "https://storage.example.test",
      "server-only",
      "lira-attachments",
      fetcher,
    );
    await adapter.verifyBucket();
    const key = `${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    await adapter.signUpload(key);
    const url = await adapter.signDownload(key, "notes.txt");
    expect(url).toContain("download=notes.txt");
    expect(calls[2]!.init?.body).toBe(JSON.stringify({ expiresIn: 60 }));
    expect(calls[1]!.init?.headers).not.toHaveProperty("x-upsert");
    await expect(adapter.signUpload("../escape")).rejects.toThrow(
      "Invalid object key",
    );
    const publicAdapter = supabaseStorage(
      "https://storage.example.test",
      "server-only",
      "lira-attachments",
      async () =>
        Response.json({
          public: true,
          file_size_limit: MAX_FILE_BYTES,
          allowed_mime_types: ["text/plain"],
        }),
    );
    await expect(publicAdapter.verifyBucket()).rejects.toThrow("private");
  });
});
