import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { assertWorkerRole, claimJob, processJob } from "./worker.js";
import { resendAdapter } from "./email.js";
const connectionString = process.env.WORKER_DATABASE_URL;
if (!connectionString) throw new Error("WORKER_DATABASE_URL is required.");
const url = new URL(connectionString);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
  url.searchParams.get("sslmode") !== "verify-full"
)
  throw new Error("Remote worker database requires sslmode=verify-full.");
const appUrl = process.env.APP_URL ?? "http://localhost:5173";
const site = new URL(appUrl);
if (
  (site.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(site.hostname)) ||
  site.username ||
  site.password ||
  site.search ||
  site.hash
)
  throw new Error("APP_URL must be a trusted HTTPS application URL.");
const emailEnabled = process.env.ASSIGNMENT_EMAIL_ENABLED === "true";
if (
  emailEnabled &&
  (!process.env.RESEND_API_KEY ||
    !process.env.EMAIL_FROM ||
    !process.env.APP_URL)
)
  throw new Error(
    "Email delivery requires RESEND_API_KEY, EMAIL_FROM and APP_URL.",
  );
const emailDailyLimit = Number(process.env.EMAIL_DAILY_LIMIT ?? 100);
if (
  !Number.isInteger(emailDailyLimit) ||
  emailDailyLimit < 1 ||
  emailDailyLimit > 10000
)
  throw new Error("EMAIL_DAILY_LIMIT must be between 1 and 10000.");
const pool = new pg.Pool({
  connectionString,
  max: 2,
  statement_timeout: 5000,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
await assertWorkerRole(pool);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    stopping = true;
  });
console.log(JSON.stringify({ event: "worker_started", emailEnabled }));
try {
  while (!stopping) {
    try {
      const job = await claimJob(pool);
      if (!job) {
        await delay(2000);
        continue;
      }
      const completed = await processJob(pool, job, {
        appUrl,
        emailDailyLimit,
        suppressEmail: !emailEnabled,
        emailFrom: emailEnabled ? process.env.EMAIL_FROM : undefined,
        sendEmail: emailEnabled
          ? resendAdapter(process.env.RESEND_API_KEY!)
          : undefined,
      });
      console.log(
        JSON.stringify({
          event: completed ? "job_completed" : "job_retry_or_failed",
          jobId: job.id,
          attempt: job.attempts,
        }),
      );
    } catch {
      console.error(JSON.stringify({ event: "worker_database_unavailable" }));
      await delay(5000);
    }
  }
} finally {
  await pool.end();
}
