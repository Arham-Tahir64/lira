import pg from "pg";
const connectionString = process.env.MIGRATION_DATABASE_URL;
const password = process.env.WORKER_DATABASE_PASSWORD;
if (!connectionString || !password || password.length < 16)
  throw new Error(
    "Set MIGRATION_DATABASE_URL and WORKER_DATABASE_PASSWORD (at least 16 characters).",
  );
const client = new pg.Client({ connectionString });
await client.connect();
try {
  // quote_literal is evaluated by PostgreSQL, avoiding interpolation of unescaped secrets.
  const literal = (
    await client.query("SELECT quote_literal($1::text) AS value", [password])
  ).rows[0].value as string;
  await client.query(
    `CREATE ROLE lira_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal} IN ROLE app_worker`,
  );
  console.log(
    "Created restricted lira_worker login. Configure WORKER_DATABASE_URL separately.",
  );
} catch {
  // Do not print a failed CREATE ROLE statement containing the password.
  throw new Error(
    "Login provisioning failed. Check whether lira_worker already exists and inspect database administrator logs securely.",
  );
} finally {
  await client.end();
}
