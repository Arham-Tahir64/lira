# Workspace overview, templates, and export

This increment implements the next planned MVP features. It keeps the existing modular monolith, tenant-scoped PostgreSQL access, durable worker, and desktop-first UI. Sprints, configurable workflows, billing, and template editing remain deferred.

## Try it locally

Apply migration 007 with `npm run db:migrate` using the migration connection, then restart `npm run dev`. The existing API and worker logins inherit new grants; do not give either owner privileges.

- Select **Workspace overview** in the sidebar to see assigned tasks, overdue work, status counts and project progress. Click a task to open its editor, or a project to open its board. The existing board remains the default project view.
- Select **Create project**, optionally enter a semester/term, and choose **Event planning** or **Semester onboarding & handoff**. Preview the starter tasks before creating the project. Blank projects remain available.
- Administrators find **Request workspace export** at the bottom of the overview. Exports require the additional storage configuration below and a running worker.

## Dashboard semantics

`GET /api/v1/orgs/{org}/dashboard` returns status counts and up to 100 active project summaries. `GET /api/v1/orgs/{org}/dashboard/tasks?kind=mine|overdue&after={id}` provides 20-task cursor pages, ordered by due date (undated last), then UUID. Every query establishes active tenant membership and RLS before reading domain rows.

- Status counts and progress include planned and backlog tasks in non-archived projects. Progress means completed task count divided by total task count, not effort or hours.
- My tasks includes only the current member's unfinished assignments.
- Overdue includes unfinished tasks with a due date strictly before today's date in `organizations.timezone`. A task due today is not overdue. The UI displays the date used.
- Archived projects are excluded from dashboard counts and attention lists but remain accessible through project navigation and export.
- These are live views with 30-second foreground polling and manual refresh. Counts and separately paginated lists can change between requests. Changed/missing cursor anchors require refresh; they are not historical snapshots. New project creation enforces the existing 100-project pilot listing boundary.

Projects are organization-visible in this MVP. If private projects are introduced, apply their visibility predicate to dashboard aggregates, task pages and exports together.

## Bundled templates

`GET /api/v1/orgs/{org}/templates` returns the two maintained, code-bundled templates. The existing project POST accepts optional `templateId` (`event` or `semester`), `term` (up to 60 characters), and UUID `clientKey`.

Project, board, starter tasks, activity, outbox records and the retry response commit in one transaction. The same client key with the same fields returns the original project; conflicting reuse returns 409. Administrator permission is checked on every attempt. Existing callers without a client key continue to work, but should provide one for safe retries.

Event planning creates seven tasks covering goals, venue/accessibility, budget, promotion, volunteers, event day and review. Semester onboarding/handoff creates six tasks covering goals, member onboarding, access review, recurring responsibilities, executive handoff and manual archiving. Checklist text lives in normal task descriptions, which members can edit. There is no separate checklist engine, automatic assignment, generated due date, automatic archive, or template editor. Term labels are captured at creation; project metadata editing remains future work.

## Export storage setup

Use a **separate private bucket**, for example `lira-exports`, in the existing Supabase project. Set its maximum file size to **5242880 bytes** and its only allowed MIME type to **application/json**. Never add JSON to the attachment bucket to enable exports. Browser roles must have no direct read/write policies on the export bucket.

In both API and worker environments, set:

```sh
export EXPORT_BUCKET='lira-exports'
```

Also provide the existing server-only `SUPABASE_URL` and `STORAGE_SERVER_KEY`. Both services verify bucket privacy, size and media restrictions at startup. `EXPORT_BUCKET` must differ from `STORAGE_BUCKET` (default `lira-attachments`). A configured storage key also retains the existing attachment bucket startup validation. No credentials, bucket creation or hosting changes are performed automatically.

After rebuilding, run the existing worker with `npm run start:worker`. If `EXPORT_BUCKET` is unset, the dashboard/templates work and the export UI explains that storage is unavailable. Do not put storage credentials into frontend variables or `SUPABASE_PUBLIC_KEY`.

## Export API, data scope, and limits

- `POST /api/v1/orgs/{org}/exports`, body `{ "clientKey": "UUID" }`: Owner/Admin only; returns 202 with an export ID. Idempotent retries reuse the request. Two requests per rolling 24 hours, and at most four exports awaiting physical cleanup, keep an outage from accumulating unlimited stored files.
- `GET /api/v1/orgs/{org}/exports`: Owner/Admin only; returns availability and the latest ten requests with status, expiry and sanitized failure information. Exhausted worker attempts are displayed as failure rather than an endless waiting state.
- `POST /api/v1/orgs/{org}/exports/{id}/download`: freshly checks current active Owner/Admin access, ready state and expiry before issuing a 60-second attachment-disposition download URL. No permanent/public URL is stored.

The worker produces a versioned `lira-export` JSON document from a **repeatable-read transaction**, including organization settings, membership IDs/names/roles/state, teams and links, projects (including archived), boards, tasks, labels and links, comments, activity, and an attachment manifest. Relationships use the existing stable domain IDs. Deleted comment bodies remain scrubbed. The attachment manifest contains filenames, object keys, checksums, byte counts and lifecycle states, **not attachment file bytes or signed links**.

Authentication profiles, auth subject IDs, contact emails, invitation credentials, notification preferences/inboxes, billing secrets, idempotency tables and job internals are excluded. This is a portable collaboration-data export, not a complete database backup or an implemented import/restore feature. Archived work is included; private projects are not yet a product feature.

The worker reads bounded 100-row batches, with a 20,000-row limit per dataset, a 20-second generation budget, and a **5 MB total serialized document limit**. It explicitly fails larger exports and directs the administrator to a maintainer for a complete export; it never returns a silently truncated success. A streaming/chunked larger export is a future scaling task. These limits are appropriate for pilot clubs, not a claim of unlimited export capacity.

## Retry, revocation, and expiry

Export jobs use the existing fenced worker leases and retry/backoff behavior. Provider calls occur outside database transactions. Only the first successful immutable object upload wins; a retry reads that original object's identity and snapshot timestamp before recording success. It cannot overwrite a previously generated snapshot with changed data. Requester administrator access is checked before generation and again before making the export ready.

Export requests expire 24 hours after creation. Download access stops at expiry; a cleanup job scheduled at 25 hours removes the private object and marks the record expired. The extra hour exceeds in-flight worker/provider deadlines and outstanding download capabilities. Cleanup is safe to retry after partial failure. Failed export jobs are excluded from notification-maintenance deletion so unresolved object cleanup retains a durable retry record. A provider outage keeps the retained-export cap occupied until cleanup succeeds.

As with attachments, existing signed URLs are bearer capabilities that can work until their 60-second expiry after access removal; already downloaded copies cannot be recalled. Snapshots can include content that was subsequently edited/deleted. Keep export artifacts out of long-term object replication and use the documented short retention window. A disaster restore can restore stale metadata; reconcile export objects and immediately expire old requests before reopening downloads.

Monitor failed `export.generate` / `export.cleanup` jobs through the existing admin jobs endpoint and worker logs. Resolve the cause before resetting a failed job using the worker runbook. Do not rotate object keys or manually delete a pending object's metadata to force retries. Requests that exceed the pilot size limit require a complete maintainer-assisted export rather than repeated identical jobs.

## Validation and remaining release gates

Real PostgreSQL tests cover tenant-scoped aggregation/pagination, atomic template retries, permission checks, snapshot contents, removed comment bodies, immutable provider retries, access changes after I/O, artifact expiry, retained cleanup records, quotas and explicit oversized failures. Desktop browser tests cover overview navigation, opening/editing a task, template preview/creation, and export request/download. Storage remains a fixture in automated tests.

Before club rollout, verify the real private JSON bucket, MIME/size restrictions, immutable duplicate behavior, signed download expiry and attachment disposition, worker retry after termination, and physical cleanup in staging. Export does not replace independent database/object backups or their restore rehearsal. Those gates, real-provider authentication validation, and an internal usability pilot remain pending.
