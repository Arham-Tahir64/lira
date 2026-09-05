import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

export async function migrate(connectionString: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(74195201)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS public.lira_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const directory = new URL("../db/migrations/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const source = await readFile(new URL(file, directory), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const existing = await client.query(
        "SELECT checksum FROM public.lira_migrations WHERE name=$1",
        [file],
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${file}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query(source);
        await client.query(
          "INSERT INTO public.lira_migrations(name,checksum) VALUES($1,$2)",
          [file, checksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(74195201)").catch(() => {});
    await client.end();
  }
}
if (process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      "MIGRATION_DATABASE_URL is required; never use migration credentials for the API",
    );
  await migrate(url);
  console.log("Migrations applied.");
}
