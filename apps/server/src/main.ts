import pg from "pg";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { supabaseVerifier } from "./identity.js";
import { assertRuntimeRole } from "./database.js";
import { Problem } from "./problem.js";
import { assertPublicSupabaseKey } from "./configuration.js";
import { exportStorageFromEnvironment } from "./export-storage.js";
import { storageFromEnvironment } from "./storage.js";
function required(key: string) {
  const value = process.env[key];
  if (!value)
    throw new Error(`${key} is required. See docs/local-development.md.`);
  return value;
}
const connectionString = required("DATABASE_URL");
const databaseUrl = new URL(connectionString);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname) &&
  databaseUrl.searchParams.get("sslmode") !== "verify-full"
)
  throw new Error(
    "Remote DATABASE_URL requires sslmode=verify-full for certificate-verified TLS.",
  );
const supabaseUrl = required("SUPABASE_URL").replace(/\/$/, "");
const publicKey = required("SUPABASE_PUBLIC_KEY");
assertPublicSupabaseKey(publicKey);
const url = new URL(supabaseUrl);
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(url.hostname)
)
  throw new Error("Supabase must use HTTPS outside local development.");
const pool = new pg.Pool({
  connectionString,
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
await assertRuntimeRole(pool);
const app = await buildApp({
  pool,
  attachments: await storageFromEnvironment(),
  exportStorage: await exportStorageFromEnvironment(),
  assignmentEmailEnabled: process.env.ASSIGNMENT_EMAIL_ENABLED === "true",
  supabaseUrl,
  publicKey,
  verifyIdentity: supabaseVerifier(supabaseUrl, publicKey),
  logger: true,
  webRoot: fileURLToPath(new URL("../../web/dist", import.meta.url)),
  revokeProvider: async (token) => {
    const response = await fetch(`${supabaseUrl}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: publicKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok && response.status !== 401)
      throw new Problem(
        503,
        "logout_pending",
        "Local access was revoked. Retry sign-out to end the provider session.",
      );
  },
});
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "127.0.0.1",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void app.close().then(() => pool.end());
  });
