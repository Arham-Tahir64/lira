# Invitation email

Automatic invitation email is implemented and **disabled by default**. Manual, email-bound invitation links continue to work. No live email was sent during implementation; tests use a simulated transport.

## Enable for an authorized staging test

Apply migration 008 with the migration identity before updating API and worker. Run the existing worker using its restricted database login; no additional queue service is required.

Set these server-only values on **both API and worker**:

- `INVITATION_EMAIL_ENABLED=true`
- `INVITATION_EMAIL_ENCRYPTION_KEY`: the same base64-encoded 32-byte key on both processes. Generate it using `openssl rand -base64 32` and store it in your hosting secret manager. Never put it in public configuration, source control, logs or browser variables.
- `EMAIL_FROM`: an address on your verified sending domain.
- `APP_URL`: the trusted frontend origin, such as `https://lira.example.org`; no path, credentials, query or fragment. HTTP is allowed only on localhost/127.0.0.1 for development.

Set `RESEND_API_KEY` on the **worker only**. `EMAIL_DAILY_LIMIT` is shared by invitation and assignment email (default 100 globally, additionally capped at 50 per workspace per UTC day). Reservations are durable and retries reuse the same reservation. Assignment email remains separately controlled by `ASSIGNMENT_EMAIL_ENABLED` and recipient preferences.

Both processes validate invitation configuration at startup when enabled; the worker also requires the provider key. Enable the worker first, then the API. Disabling invitation email on the worker cancels and scrubs queued invitations as it processes them; it does not defer a burst until re-enabled.

## Behavior and data boundaries

Invitation creation atomically records the invitation hash, an encrypted email intent, activity, delivery job and expiry job. The email contains the email-bound invitation link, using a URL fragment, and a generic workspace invitation message. Invitation tokens are never put in activity or job payloads. The immutable request is AES-256-GCM encrypted with organization/invitation IDs authenticated as additional data; API database credentials cannot read ciphertext. Tenant RLS and composite foreign keys apply to the intent.

The worker rechecks the recipient binding, acceptance/revocation, invitation expiry, active inviter, disabled account and current role before sending. It does not hold a transaction over provider I/O. An invitation revoked immediately after the last authorization check may still produce an email; acceptance independently rechecks authorization, so the link cannot restore revoked access.

Retries use the same request and `invitation/<event-id>` provider idempotency key, including after an uncertain response. Sending is bounded to 20 hours after creation, within the adapter's documented 24-hour provider deduplication window. This is not an exactly-once delivery guarantee. Permanent rejection stops retries. Other failures follow the existing eight-attempt worker policy; inspect failed jobs before operator recovery. Do not replay jobs beyond the intent expiry or regenerate a provider key for the same message.

Encrypted content is cleared on successful provider acceptance, explicit invitation acceptance/revocation, permanent provider rejection, worker cancellation or expiry. A separate job clears it after 20 hours even if sending exhausted retries. Offboarding revokes invitations; the worker cancels their delivery when processed. Normal seven-day invitation validity is independent of the shorter email delivery window. Backups may retain historical encrypted bytes until their retention expires; secret and backup access must remain restricted.

The People screen polls status every 15 seconds while active. “Email accepted by provider” does not prove inbox delivery. Bounce/delivery webhooks and resend are not implemented. If sending fails, share the saved one-time link or revoke and create a new invitation. The original raw link cannot be recovered through the API.

## Operations and release gate

- Run `npm run maintenance:notifications` to preview retention, including expired encrypted invitation payloads; use its documented apply mode to scrub at most 500 per run when the worker was offline. Repeat bounded runs until the count is zero. Failed invitation jobs are retained for investigation. See [worker maintenance](notifications-and-worker.md).
- Alert on overdue jobs and run maintenance independently of the worker. Expiry is enforced on read/send even if physical cleanup is delayed by an outage.
- Drain or cancel pending intents before rotating the encryption key on both processes. There is no key ring: changing the key prematurely causes safe decryption failures until expiry cleanup, not plaintext recovery or sending with changed content.
- After restoring a backup, expiry checks prevent old mail replay. Preserve timestamps and idempotency keys. Check pending intents and worker configuration before starting it.
- Before inviting real members, authorize test recipients and verify your provider domain, API/worker secrets, budget, spam placement, signup/verification redirects, acceptance and revocation in staging. Fixture tests do not establish provider delivery. Provider retention and bounce handling need review before external-club launch.

Automatic invitation email does not enable Supabase signup/reset email; configure the identity provider's SMTP separately. No new vendor account, deployment or provider credentials are provisioned by this increment.
