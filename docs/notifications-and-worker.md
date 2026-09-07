# Notifications and worker operations

The worker is a second process from the same codebase and Docker image. It is implemented but has not been deployed to a real provider. No mail has been sent during development; tests use an injected adapter or HTTP fixture.

## Start with in-app delivery

1. Apply migration 004 using the migration credential.
2. Set `MIGRATION_DATABASE_URL` and a separate `WORKER_DATABASE_PASSWORD` (at least 16 characters) in a one-off provisioning environment; run `npm run db:provision-worker`.
3. Give the worker only `WORKER_DATABASE_URL` for the resulting `lira_worker` login, with certificate-verified TLS remotely. Do not reuse the web or migration login. `app_worker` has tenant-scoped domain policies. It can execute narrow scheduler functions but cannot inherit the `app_scheduler` function-owner role or access unscoped domain rows.
4. Deploy the same built image with start command `node apps/server/dist/worker-main.js` (or locally, after `npm run build`, `npm run start:worker`). One process, concurrency one, two database connections. It polls every two seconds while idle. SIGTERM/SIGINT finishes the current bounded operation and closes the pool.
5. Leave `ASSIGNMENT_EMAIL_ENABLED` unset/false in both web and worker. When the worker flag is false, previously opted-in memberships also receive in-app-only delivery. Create an assignment from one active member to another, then confirm the recipient sees it in Notifications. Self-assignments, removed recipients, changed-away assignments, and archived projects do not produce new notifications. Updates that do not change assignment do not notify again.

The worker processes the existing issue outbox. Earlier events without assignment information are consumed without inventing recipient history. Repeated event processing creates at most one in-app row per event/recipient. Existing in-app history remains readable to its active recipient; removal immediately blocks access through both the API and RLS.

## Enable assignment email only after staging verification

Configure the worker with `RESEND_API_KEY`, `EMAIL_FROM` (verified sending domain), and `APP_URL` (trusted HTTPS application URL). Set `ASSIGNMENT_EMAIL_ENABLED=true` in both web and worker. Only the worker needs the mail key. The flag exposes the per-membership opt-in; opting in is never automatic. The API mirrors the provider-verified contact address on authenticated requests. Delivery requires a contact verified within the preceding 24 hours. Stale contacts receive in-app delivery only until the member next authenticates to the API.

The adapter calls [Resend's send-email endpoint](https://resend.com/docs/api-reference/emails/send-email), with a stable event/recipient key and a stored immutable request. Resend documents a [24-hour idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys). Lira stops attempting assignment email after 20 hours from the event/intent, including manual retry, to stay within that window and avoid old-message bursts. This is at-least-once processing with deduplication, not an exactly-once guarantee. Email bodies contain only a generic assignment notice and application sign-in URL; titles and descriptions stay in the authenticated app.

Current membership, preference, address, assignment and project access are rechecked before sending. Network I/O happens outside database transactions. There is an unavoidable interval between the final access check and provider acceptance: a request already in flight cannot be recalled after offboarding. The generic body limits disclosure in that interval.

`EMAIL_DAILY_LIMIT` defaults to 100 globally (allowed range 1–10,000); each organization is additionally capped at 50 new email reservations per database calendar day. Reservations serialize in PostgreSQL and retries reuse a reservation. Exhausted budget defers the job to the next day; old events may then become in-app-only. These caps cover this worker, not Supabase authentication email or other applications sharing the provider account. Set all workers to the same limit and budget shared provider traffic separately. Conservative reservations may count requests the provider never accepted.

## Failure handling and monitoring

Claims use `FOR UPDATE SKIP LOCKED`, a fresh 60-second lease token and incremented attempts. Completion/retry requires the same unexpired token. Email HTTP calls time out after ten seconds. Expired leases are reclaimable after bounded backoff/jitter; eight exhausted attempts enter `failed`. Other transient failures use exponential backoff and jitter. Permanent mail rejections and unknown job types fail explicitly; errors are fixed codes, never provider bodies, addresses, or task content.

The recipient inbox is paginated and supports read/unread updates. Admins can inspect `GET /api/v1/orgs/{orgId}/jobs/status`: counts by state and the latest 30 failed jobs, with IDs, types, attempts, timestamps and sanitized errors. Ordinary members cannot inspect this operational endpoint. Worker JSON logs include only job ID, attempt and outcome. Configure hosted log alerts for `worker_database_unavailable`, failed jobs, and a growing pending backlog before production; alert destinations are not yet provisioned.

An operator should inspect a failed job, correct the cause, and use a one-off database session to reset only that failed job's state to `pending`, attempts to zero, run_at to now, and lease fields to NULL. Do not reset processing jobs, regenerate event IDs, or delete email intents/reservations to force another email. Reprocessing old assignment jobs may intentionally skip email. There is no public arbitrary-job enqueue or retry endpoint.

## Retention

`npm run maintenance:notifications` reports eligible counts using a one-off migration/maintenance credential. `npm run maintenance:notifications -- --apply` deletes at most 500 eligible rows per table per invocation: email intents after seven days, notifications after 90 days, completed jobs after seven days, failed jobs other than attachment/export jobs after 30 days from creation, and reservations after 30 days. It never deletes activity history, pending/processing jobs, or failed attachment/export jobs that may still be required for cleanup. It is not scheduled automatically; review the counts and run it operationally until a managed maintenance schedule is authorized. No runtime gets this credential.

## Remaining delivery work

Invitation emails are still manual links. The raw token cannot be recovered from the stored hash. Automated invitation delivery requires a separately reviewed short-lived encrypted delivery secret, expiry/revocation checks, and verified sender/staging tests; do not store plaintext tokens in outbox payloads. Signup/recovery messages remain Supabase Auth's responsibility. Bounces/suppression feedback, unattended retention, and hosted alerting must be validated before external beta.
