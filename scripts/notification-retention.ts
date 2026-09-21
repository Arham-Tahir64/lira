import type pg from "pg";
export async function cleanupNotifications(
  client: pg.Client | pg.Pool,
  apply = false,
) {
  const rules = [
    ["email_deliveries", "created_at<now()-interval '7 days'"],
    ["notifications", "created_at<now()-interval '90 days'"],
    [
      "outbox_jobs",
      "(state='completed' AND completed_at<now()-interval '7 days') OR (state='failed' AND type NOT LIKE 'attachment.%' AND type NOT LIKE 'export.%' AND type NOT LIKE 'invitation.%' AND created_at<now()-interval '30 days')",
    ],
    ["email_reservations", "day<CURRENT_DATE-30"],
  ] as const;
  const report: Array<{ table: string; count: number }> = [];
  for (const [table, predicate] of rules) {
    const count = apply
      ? ((
          await client.query(
            `DELETE FROM app.${table} WHERE ctid IN (SELECT ctid FROM app.${table} WHERE ${predicate} LIMIT 500)`,
          )
        ).rowCount ?? 0)
      : (
          await client.query(
            `SELECT count(*)::int AS count FROM app.${table} WHERE ${predicate}`,
          )
        ).rows[0].count;
    report.push({ table, count });
  }
  const expired = "encrypted_payload IS NOT NULL AND expires_at<=now()";
  const scrubbed = apply
    ? ((
        await client.query(
          `UPDATE app.invitation_emails SET encrypted_payload=NULL,state=CASE WHEN state='queued' THEN 'expired' ELSE state END WHERE ctid IN (SELECT ctid FROM app.invitation_emails WHERE ${expired} LIMIT 500)`,
        )
      ).rowCount ?? 0)
    : (
        await client.query(
          `SELECT count(*)::int AS count FROM app.invitation_emails WHERE ${expired}`,
        )
      ).rows[0].count;
  report.push({ table: "invitation_email_payloads", count: scrubbed });
  return report;
}
