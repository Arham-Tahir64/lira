import pg from "pg";
import type { Identity } from "./identity.js";
import { Problem } from "./problem.js";
import type { Membership } from "@lira/contracts";
export type Transaction = pg.PoolClient;
export async function withIdentity<T>(
  pool: pg.Pool,
  identity: Identity,
  run: (tx: Transaction) => Promise<T>,
  allowRevoked = false,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(
      "SELECT set_config('app.user_id',$1,true),set_config('app.org_id','',true),set_config('app.display_name',$2,true),set_config('statement_timeout','5000',true),set_config('lock_timeout','3000',true)",
      [identity.id, identity.displayName],
    );
    await tx.query(
      "INSERT INTO app.users(id,auth_subject,display_name) VALUES($1,$1,$2) ON CONFLICT(id) DO NOTHING",
      [identity.id, identity.displayName],
    );
    await tx.query(
      "UPDATE app.users SET verified_email=$2,email_verified_at=now() WHERE id=$1",
      [identity.id, identity.email.trim().toLowerCase()],
    );
    const { rows } = await tx.query(
      "SELECT disabled_at,sessions_revoked_before FROM app.users WHERE id=$1",
      [identity.id],
    );
    if (
      !rows[0] ||
      rows[0].disabled_at ||
      (rows[0].sessions_revoked_before &&
        identity.issuedAt * 1000 <=
          new Date(rows[0].sessions_revoked_before).getTime())
    )
      throw new Problem(401, "inactive_session", "Please sign in again.");
    const revoked = await tx.query(
      "SELECT session_id FROM app.revoked_sessions WHERE session_id=$1 AND user_id=$2 AND expires_at>now()",
      [identity.sessionId, identity.id],
    );
    if (revoked.rowCount && !allowRevoked)
      throw new Problem(401, "inactive_session", "Please sign in again.");
    const result = await run(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function withTenant<T>(
  pool: pg.Pool,
  identity: Identity,
  orgId: string,
  run: (tx: Transaction, membership: Membership) => Promise<T>,
  lock: "shared" | "exclusive" = "shared",
) {
  return withIdentity(pool, identity, async (tx) => {
    // This first query runs with user context only; it cannot read another user's memberships.
    await tx.query(
      lock === "exclusive"
        ? "SELECT pg_advisory_xact_lock(hashtextextended($1,1))"
        : "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,1))",
      [orgId],
    );
    const { rows } = await tx.query<Membership>(
      "SELECT id,role,user_id FROM app.memberships WHERE org_id=$1 AND user_id=$2 AND state='active'",
      [orgId, identity.id],
    );
    const membership = rows[0];
    if (!membership)
      throw new Problem(404, "not_found", "Workspace not found.");
    await tx.query("SELECT set_config('app.org_id',$1,true)", [orgId]);
    return run(tx, membership);
  });
}
export async function assertRuntimeRole(pool: pg.Pool) {
  const result = await pool.query(`SELECT r.rolsuper,r.rolbypassrls,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND pg_has_role(current_user,c.relowner,'USAGE')) AS owns_tables,
    EXISTS(SELECT 1 FROM pg_roles f WHERE f.rolname IN ('app_bootstrap','app_invitation_accept','app_owner_guard','app_scheduler','app_worker') AND pg_has_role(current_user,f.oid,'MEMBER')) AS privileged_function_role,
    pg_has_role(current_user,'app_api','MEMBER') AS api_member FROM pg_roles r WHERE rolname=current_user`);
  const role = result.rows[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.owns_tables ||
    role.privileged_function_role ||
    !role.api_member
  )
    throw new Error(
      "DATABASE_URL must use a non-owner, non-superuser, non-BYPASSRLS app_api member.",
    );
}
