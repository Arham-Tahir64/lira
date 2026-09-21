# Task attachments: internal pilot

Attachments follow the accepted architecture's private Supabase Storage and PostgreSQL worker design. This increment supports internal-pilot workspaces only. It does not enable public file sharing or external-club uploads, and signature checks are **not malware scanning**. An isolated scanner and an explicit policy change are required before external beta uploads.

## Configuration

Apply migration 006 with the existing migration command. The existing restricted API and worker logins inherit the new table grants; neither needs owner or BYPASSRLS privileges.

Create a **private** Supabase Storage bucket named `lira-attachments`, with `file_size_limit` of **10485760** and `allowed_mime_types` exactly `application/pdf`, `image/png`, `image/jpeg`, `text/plain`. Use the project's existing Supabase origin. Do not grant browser `anon` or `authenticated` roles direct bucket/object access; signed capabilities are the only browser transfer path. Keep overwrite/upsert disabled. Review existing storage policies for wildcard access that could expose this bucket.

Configure these server-only environment variables in **both web/API and worker services** using the hosting secret manager, never frontend build variables:

| Variable                | Purpose                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| `SUPABASE_URL`          | Existing identity and storage project origin                                |
| `STORAGE_SERVER_KEY`    | Dedicated server-side storage credential; kept inside the storage adapter   |
| `STORAGE_BUCKET`        | Optional; defaults to `lira-attachments`                                    |
| `ATTACHMENT_PILOT_ORGS` | Comma-separated internal-club organization UUIDs approved for pilot uploads |

Without a storage key, transfers are unavailable and uploads are disabled. Configuring pilot UUIDs without a key fails startup. With a key, startup verifies the bucket is private and has explicit allowed MIME types and a size limit at most 10 MB. An empty pilot list disables new upload reservations/completion while existing ready downloads and cleanup can continue. Keep the worker running and identically configured.

Supabase server credentials may have broader provider authority than this bucket; the application adapter's fixed bucket and generated paths constrain use, but do not turn a broad provider key into a bucket-scoped credential. Store/rotate it separately from public authentication configuration and database credentials. Review provider credential capabilities and bucket policies in staging. No secrets or buckets are provisioned automatically.

Supabase documents [bucket size/type restrictions](https://supabase.com/docs/guides/storage/buckets/creating-buckets). The adapter matches the installed Supabase Storage client's signed-upload and signed-download REST protocol. Confirm provider behavior in the staging checklist below before using real files.

## API and lifecycle

All routes are under `/api/v1`, require verified authentication and active tenant membership, and return `Cache-Control: no-store`.

| Route                                                   | Behavior                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /orgs/{org}/issues/{issue}/attachments?after={id}` | Chronological pages of 30; metadata, workspace usage and upload availability. Object keys, checksums and provider credentials are excluded.                  |
| `POST /orgs/{org}/issues/{issue}/attachments`           | Reserve quota and return attachment ID, signed upload URL and completion deadline. Body: `name`, `mediaType`, `bytes`, SHA-256 `checksum`, UUID `clientKey`. |
| `POST /orgs/{org}/attachments/{id}/complete`            | Uploader-only, idempotent transition to quarantine; queue validation. Acknowledges submission, not successful validation.                                    |
| `POST /orgs/{org}/attachments/{id}/download`            | Fresh membership/project check and ready-state check; return a signed download capability lasting 60 seconds.                                                |
| `DELETE /orgs/{org}/attachments/{id}`                   | Uploader or organization administrator only; stop new downloads and enqueue retryable removal.                                                               |

Archived projects remain readable, including ready downloads, but reject upload, completion and removal writes. Organization-visible projects retain the existing permissions model; private projects remain deferred.

1. Validate the declared media type, filename, size and checksum. Serialize reservations with a tenant advisory lock. Cap active attachments at 50 per issue and 500 per workspace.
2. Reserve **10 MB per pending upload**, even if the declared file is smaller. This protects the **1 GB workspace quota** from a client uploading more than it declares. Totals derive from indexed attachment records, avoiding drift between metadata and a separate counter. Completed validation reduces the charge to verified bytes.
3. Generate an immutable `organization/project/attachment` object key, without user filenames. Signed upload creation never enables upsert. The browser sends bytes directly to storage without its application bearer token.
4. The browser may finish within **15 minutes** of reservation. Creation retries with the same client key and identical metadata reuse the reservation within that deadline. Supabase [signed upload URLs last two hours](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl); application expiry does not revoke an already issued capability.
5. The worker reads at most 10 MB with a bounded provider timeout, verifies actual byte count, SHA-256 and a matching PDF/PNG/JPEG/UTF-8 text signature, then rechecks uploader access and project state before marking ready. Files remain quarantined during transient failures. Invalid data moves to deleting with a generic rejection reason. Raw contents, checksums and signed URLs are not copied to activity logs.
6. Cleanup is enqueued atomically at reservation for **three hours** after creation. This exceeds the last allowed 15-minute re-sign window plus the provider's two-hour capability lifetime and a safety margin. Cleanup expires pending/quarantined files and removes rejected/deleting files; it leaves ready files intact. Deletion of a ready file also enqueues cleanup no earlier than that deadline.
7. Storage deletion precedes SQL finalization. Retries are safe when bytes are already missing; quota is released only after storage reports successful removal. The charged amount remains unchanged while deleting. Metadata tombstones and client keys remain for retry safety.

A lost successful upload response can be retried without overwriting bytes. A provider duplicate response proceeds to worker validation of the original checksum. A different object cannot become ready through a mismatched retry.

Existing signed downloads can work until their 60-second expiry even after removal/offboarding, and downloaded copies cannot be recalled. Downloads use the storage origin and an attachment disposition; no inline preview is offered. This is not DRM or a substitute for malware scanning. File-signature validation is intentionally narrower than full document parsing.

## Failure handling and operations

Attachment jobs reuse the existing 60-second fenced leases, eight-attempt limit and bounded retry backoff. Provider calls have a 15-second timeout, and object reads are bounded in memory. Failed validation does not expose bytes. A cleanup provider outage retains the charged quota, rather than claiming bytes were deleted.

Monitor `/orgs/{org}/jobs/status`, worker failures and jobs overdue for cleanup. After resolving a provider/configuration failure, reset only the affected failed job following the worker runbook. Do not delete its attachment metadata or object key before successful cleanup. Notification retention deliberately preserves failed attachment jobs so an unresolved cleanup cannot silently lose its durable retry record. Completed jobs retain the existing retention policy.

Database metadata and external bytes are not one transaction. Restoring an older database can omit recently created objects; reconcile a provider inventory against the restored attachment manifest, allowing a safety window for still-valid upload capabilities, before deleting any orphan. Never infer an orphan solely from an API page or a temporarily missing tenant context.

## Object backup and staging release gates

No live credentials were available during implementation. These remain deployment gates, not completed checks:

- In a separate staging Supabase project, verify private bucket and global storage policies; anonymous/direct object reads and unsigned writes must fail.
- Exercise a real browser upload, worker validation and download. Verify signed uploads cannot overwrite, replay/expiry behavior matches the two-hour assumption, cache behavior respects expiry, and downloads set attachment disposition. If provider lifetimes differ, adjust cleanup timing before rollout.
- Verify content-size enforcement for deliberately false size/MIME declarations, worker storage failure/recovery, revoked membership, archived projects and expiry cleanup. Tests use real PostgreSQL and fixture storage; they do not prove provider behavior.
- Configure an independently credentialed backup destination. Nightly, capture a database backup and a manifest of ready attachments (`org_id`, object key, declared/verified bytes, SHA-256, creation and copy timestamps), copy immutable ready bytes to that destination, and verify checksums. Record objects that became ready after the snapshot for the next pass. Keep this backup credential out of web/worker services.
- Restore the database and manifest into a separate environment, copy backed-up bytes to a private restore bucket, recheck checksums and tenant access, and measure missing bytes, recovery point and recovery time. Database backups alone do not contain Storage objects. Do not roll out club file storage until this independent copy and restore rehearsal pass.
- Define backup retention and deletion expiry in the club privacy notice. App removal blocks new access immediately; physical cleanup is delayed as above, and backups age out on their published schedule.

Production backup automation and a malware-scanning service are not provisioned by this increment. No external-club uploads should be enabled by adding outside organizations to the internal pilot list.
