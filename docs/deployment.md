# Deployment and operations: foundation

No production service is created by this repository. Provision staging before internal production and complete the open Phase 1 gates in `implementation-status.md`.

## Planned topology

Render web service serving the compiled React app and Fastify API; Supabase PostgreSQL/Auth; a separate worker from the same application codebase in Phase 2. Private storage, email notifications, and billing arrive with their scheduled features. No Redis or additional backend framework is introduced.

## Required environment

| Variable                 | Where                              | Purpose                                                               |
| ------------------------ | ---------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`           | Web service                        | Restricted app_api member; remote URLs must use `sslmode=verify-full` |
| `SUPABASE_URL`           | Web service                        | Auth project HTTPS URL                                                |
| `SUPABASE_PUBLIC_KEY`    | Web service/public config          | Publishable/anonymous public key only, never a service-role key       |
| `HOST`                   | Web service                        | `0.0.0.0` in a container; loopback locally                            |
| `PORT`                   | Web service                        | 3000 or the port provided by the platform                             |
| `MIGRATION_DATABASE_URL` | One-off migration environment only | Elevated credentials; never attach to the running API                 |
| `APP_DATABASE_PASSWORD`  | One-off role provisioning only     | Separate app login credential; not used by ordinary runtime           |

Use provider-managed secrets. Verify database certificates; do not bypass TLS validation to connect a pooler. Start with five API pool connections per process and budget the sum across future replicas/workers. The `app` schema must remain unexposed through the Supabase Data API.

## Staging release

1. Set up an empty Supabase staging project; configure email verification, custom SMTP, asymmetric JWT signing, and precise allowed redirects. Configure JWT lifetime to 30 minutes.
2. Apply migrations with a role permitted to create/assign the restricted roles. If the hosted migration role lacks a privilege, stop and provision the documented roles through the platform's supported administrative path; do not change the web service to an owner connection.
3. Provision `lira_api` using the separate provisioning script. Store its URL in web-service secrets, with certificate-verified TLS.
4. Build the Docker image from the repository root. Deploy the image to a staging web service, with `/health/ready` as its health check.
5. Test real email confirmation, sign-in, organization creation, a project/task mutation, logout, and rejected cross-organization access.
6. Verify deployed static files, CSP, browser redirects, rate limits, safe logs, graceful termination, and that migrations are not run automatically by every replica.

The image includes the migration source and `tsx` tooling so an authorized one-off command can run `npm run db:migrate` before a release. Migration credentials are supplied only to that command. Later optimize the image/tooling separation if size or attack-surface measurements justify it.

## Database roles

- Migration owner: owns tables; never used for web requests.
- `app_api`: non-login runtime privilege group; no RLS bypass, ownership, or role creation.
- `app_bootstrap`: non-login role owning only the bounded organization-creation function. It has narrowly granted organization/membership access; ordinary logins must **not** inherit it.
- `app_invitation_accept`: non-login function role for bounded invitation acceptance; no runtime login may inherit it.
- `app_owner_guard`: non-login read-only trigger role enforcing the last-owner invariant.
- `lira_api`: login inheriting `app_api`, provisioned separately from migrations. Test startup rejects privileged connections.

Organization-scoped requests acquire a shared advisory lock, verify membership, set transaction-local tenant context, and use the same checked-out connection. Roster and team mutations use the matching exclusive lock before changing memberships. Provider tokens never determine organization roles.

## Recovery gate before real club data

Configure daily managed database backups, an independent encrypted export, and a restore drill. When attachments arrive, add a separate object backup and manifest; a SQL backup does not contain file bytes. Keep two maintainers able to restore, deploy, rotate secrets, and manage the domain. Record measured RPO/RTO before setting expectations for the club.

## Known operational work still pending

Notification worker, upload processing, outbox retry/dead-letter management, retention cleanup, organization export/deletion, third-party error tracking, uptime alert destination, budget alerts, and independent backup automation are not configured yet. Structured API logs and health endpoints are implemented. This foundation must not be advertised as satisfying the complete internal MVP or paid-service operational gates.
