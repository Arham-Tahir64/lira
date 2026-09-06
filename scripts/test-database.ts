import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { migrate } from "./migrate.js";
const execute = promisify(execFile);
export async function setup() {
  let cleanup = async () => {};
  let url = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url) {
    // Use the packaged native PostgreSQL binaries directly. The wrapper's exit hook
    // overrides failing test exit codes; it must not be imported by the test runner.
    const binaries = (await import(
      `@embedded-postgres/${process.platform}-${process.arch}`
    )) as { initdb: string; pg_ctl: string };
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((r) => server.close(() => r()));
    const directory = await mkdtemp(join(tmpdir(), "lira-test-"));
    const data = join(directory, "data");
    const passwordFile = join(directory, "password");
    await writeFile(passwordFile, "test-only\n", { mode: 0o600 });
    await execute(binaries.initdb, [
      "-D",
      data,
      "-U",
      "postgres",
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    await execute(binaries.pg_ctl, [
      "-D",
      data,
      "-l",
      join(directory, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${directory}`,
      "-w",
      "start",
    ]);
    cleanup = async () => {
      await execute(binaries.pg_ctl, ["-D", data, "-m", "fast", "-w", "stop"]);
      await rm(directory, { recursive: true, force: true });
    };
    url = `postgresql://postgres:test-only@127.0.0.1:${port}/postgres`;
  }
  try {
    await migrate(url);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(
        "CREATE ROLE lira_test_api LOGIN PASSWORD 'test-only' IN ROLE app_api NOSUPERUSER NOBYPASSRLS",
      );
      await admin.query(
        "CREATE ROLE lira_test_worker LOGIN PASSWORD 'test-only' IN ROLE app_worker NOSUPERUSER NOBYPASSRLS",
      );
    } finally {
      await admin.end();
    }
    const runtime = new URL(url);
    runtime.username = "lira_test_api";
    runtime.password = "test-only";
    process.env.TEST_ADMIN_DATABASE_URL = url;
    process.env.TEST_DATABASE_URL = runtime.toString();
    runtime.username = "lira_test_worker";
    process.env.TEST_WORKER_DATABASE_URL = runtime.toString();
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}
