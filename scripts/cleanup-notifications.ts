import { cleanupNotifications } from "./notification-retention.js";
import pg from "pg";
const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "Use a one-off maintenance credential in MIGRATION_DATABASE_URL.",
  );
const apply = process.argv.includes("--apply");
const client = new pg.Client({ connectionString, statement_timeout: 10000 });
await client.connect();
try {
  for (const result of await cleanupNotifications(client, apply))
    console.log(
      JSON.stringify({ ...result, mode: apply ? "deleted" : "eligible" }),
    );
} catch {
  throw new Error(
    "Maintenance failed; inspect database operations without exposing credentials.",
  );
} finally {
  await client.end();
}
