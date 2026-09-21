# Implementation status

Reference: [accepted architecture](software-architecture.md), particularly Sections 14–16. This file records progress; it does not replace or broaden the architecture.

## Product direction update — September 5, 2026

The user explicitly prioritized laptop/desktop usage. New UI work, usability review, and release browser checks target desktop. Mobile-specific work and verification are deferred; existing responsive styling and optional mobile test configuration remain available. Keyboard accessibility remains required. This update supersedes the original mobile-layout acceptance criterion.

## Foundation: implemented in the preceding increment

Implemented and covered by checks:

- npm workspaces; supported TypeScript/Node runtime; React/Vite frontend; Fastify API; shared schemas; PostgreSQL migrations.
- Verified provider identities, session denylist, per-organization membership, restricted runtime roles, RLS, and same-tenant foreign keys.
- Organization bootstrap in a bounded security-definer function; maximum three owned organizations during the pilot.
- Organization/project creation and selection; one board record per project; list/board/backlog representations over issues.
- Create issues with an atomic project counter and idempotency record; status/priority/detail updates with ETags; active-assignee validation in the API.
- Atomic activity/outbox records; no fire-and-forget network work in transactions.
- Local/database tests, UI tests, CI definition, container build definition, setup/runbook documentation.

## Phase 1 exit gates still pending

- Connect the club's actual Supabase project and confirm asymmetric signing keys, verified email, custom SMTP, allowed redirects, and restricted database login provisioning there.
- Run one complete real-provider signup → verification → workspace → project → task flow in staging. Local SQL tests and UI fixtures do not substitute for this gate.
- Deploy the container to staging and verify provider TLS/network access and health checks.
- Have a second maintainer review and explain tenant context, bootstrap privileges, migrations, and deployment setup.
- Confirm the club's initial workflow and usability priorities with intended members.

## Completed increment: Phase 2 membership and teams

- Email-bound, single-use, seven-day invitation links; token hashes are stored for acceptance; optional delivery now uses the short-lived encrypted intent described below. Creation/revocation requires an administrator, and Admin invitations require an Owner.
- Invitation acceptance checks current inviter permissions, expiry/revocation, the verified recipient email, and the 100-active-member pilot cap atomically.
- A People & Teams screen supports invitation creation, role changes, member removal/leave, ownership transfer, and team membership.
- Ownership/role changes require a recent signed provider authentication method timestamp; token refresh does not qualify. The UI asks for the current password through Supabase before sensitive changes.
- Membership writes serialize with normal tenant requests. Removal clears open assignments, increments issue versions, removes team links, revokes outstanding invites created by the departing member, and reassigns project leads to an active owner. Historical attribution remains.
- A deferred PostgreSQL trigger prevents removal/demotion of the final owner even through direct SQL. Teams are organizational groups and grant no project permissions.
- Invitations provide a one-time link for the administrator to share. Optional automatic email is implemented in the invitation-email increment below. Organization activity does not imply inbox delivery.

## Completed increment: Phase 2 project workflows

- Desktop task editor for title, description, status, backlog/planned state, priority, assignee, due date, and labels. Saves use version preconditions; conflicts preserve the editor and require refresh before retry.
- Organization labels and normalized issue-label joins with forced RLS and composite tenant foreign keys. Up to 200 workspace labels and 20 labels per task; creation and application are supported.
- PostgreSQL generated full-text vector and GIN index for title/description, exact issue-key lookup, and filters for assignee, priority, label, due date, planning state, and status. Search is submitted explicitly and covers the project database, not only loaded rows.
- Independent 25-item pagination per board column; list pages remain 50. Numeric rank ordering, project-locked moves and gap rebalancing, stale-neighbor and version checks. Keyboard status selection and Move up initially provided ordering; the collaboration increment below adds drag-and-drop and Move down; reordering is disabled while filters are applied.
- Reversible project archive for administrators or the project lead. Archived tasks remain readable and reject writes at the API. No data is deleted by archiving.
- Chronological, paginated project activity with actor names and operational field changes. Description changes record only that the body changed, not copies of its contents. Before-values are captured under a row lock.
- Migration 003 adds labels, joins, search vector and indexes. Existing migrations are unchanged.

## Completed increment: durable worker and notification inbox

- Separate tenant-scoped worker role and narrow metadata scheduler functions; leases, fencing, retries, backoff/jitter and eight-attempt failed state.
- Deduplicated in-app assignment notifications, recipient-only RLS, read/unread API, desktop inbox, and opt-in email preferences.
- Resend adapter with stable request/key, current-access checks, generic content, delivery age limits and database-backed daily caps. No live provider email has been sent or enabled.
- Same-image worker entrypoint, restricted-login provisioning, admin failed-job status API, and bounded manual retention tooling. See [operations and limitations](notifications-and-worker.md).

## Completed increment: desktop task board and discussions

The user prioritized core Jira-style task functionality over the next infrastructure work. This increment stays within the planned board, backlog, assignment, and comment scope.

- Board is the default project view. Create a task directly in a status column with an assignee in one transaction; completed tasks are always planned.
- Drag handles move tasks across columns or before another card. Move up/down and status controls provide keyboard alternatives, with live move announcements. Reordering is disabled during filtering, with an explanation and Clear filters action.
- Cards display assignee and due date. Send to backlog and Plan task support day-to-day planning without opening the editor.
- The task editor includes a Discussion tab with paginated safe Markdown comments. Drafts survive switching between Details and Discussion. Raw HTML, unsafe links, and remote images are excluded.
- Authors can edit/remove their comments; organization administrators can remove others' comments. Version preconditions reject stale edits/deletes. Creation retries are idempotent; archived projects reject comment writes.
- Migration 005 adds forced-RLS comments with composite tenant/project/issue and author constraints. Deletion immediately scrubs the body and leaves a tombstone; activity records identifiers, never comment bodies. Backups remain subject to their retention period. Comment mentions and notifications are not implemented.
- Verification: 54 backend/database tests and two desktop browser scenarios cover creation, drag movement, backlog planning, comment lifecycle, Markdown safety, authorization, isolation, concurrent retries, and stale writes. Type checking, lint, formatting and production build pass. React Doctor reports maintainability/iteration advisories; the browser Supabase client is identity-only with public configuration. The approximately 609 kB uncompressed main bundle has a build size warning; route-level splitting remains a future optimization.

## Completed increment: task attachments

- Desktop Attachments tab supports direct upload, validation status, fresh-authorized download and confirmed removal. Supports PDF, PNG, JPEG and UTF-8 text; no inline previews.
- Private Supabase Storage adapter verifies bucket restrictions at startup. Uploads require an explicit internal-pilot organization allowlist in both API and worker configuration. External uploads remain disabled pending malware scanning.
- Migration 006 introduces attachment metadata with forced RLS, composite tenant/project/issue and uploader constraints, idempotent reservation keys and charged byte accounting. Atomic reservations cap workspace storage at 1 GB and reserve the full 10 MB provider limit per pending upload; counts cap at 50 per issue and 500 per workspace.
- Worker validation checks actual byte count, SHA-256 and content signature before publication. Expiry, rejection and removal use durable cleanup jobs, fenced writes and provider retries; failed attachment jobs survive notification retention.
- Signed downloads last 60 seconds. Physical deletion waits until upload capabilities have expired; metadata and reserved quota remain until successful cleanup. Archive/read-only and uploader/admin permissions follow existing project policy.
- See [configuration, lifecycle, backup and provider release gates](attachments.md). Live bucket provisioning, independent backup copy/restore rehearsal and external malware scanning are not completed by fixture tests.

## Completed increment: overview, club templates, and organization export

- Desktop Workspace overview presents personal open tasks, overdue work, status counts and project completion; task links open the editor and project links open the board. Dates use workspace timezone; archived projects are excluded. Attention lists use 20-item cursor pages and polling.
- Project creation offers two code-bundled templates with preview: seven event tasks or six semester onboarding/handoff tasks. Term labels are optional. Project/board/tasks and retry records are atomic; blank projects remain supported. No automatic assignment, scheduling or archiving is introduced.
- Administrator-requested exports use the durable worker and a separate private JSON bucket. A repeatable-read transaction captures structured collaboration data and an attachment manifest, including archived work; file bytes and authentication/private notification data are excluded.
- Fresh administrator authorization protects downloads. Immutable retries, 24-hour expiry, delayed cleanup, 5 MB/row/time bounds, request quotas and a retained-object cap control costs. Oversized exports fail explicitly for maintainer assistance rather than truncate data.
- Migration 007 adds project term/template metadata, dashboard index, export request metadata and tenant-scoped worker read grants. See [usage, configuration, semantics and release gates](overview-and-exports.md).

## Current increment: automatic invitation email

- Optional transactional invitation email uses the existing PostgreSQL outbox and worker, with no new infrastructure. Manual links remain supported when disabled.
- Migration 008 adds tenant-scoped encrypted email intents. AES-256-GCM binds immutable message content to organization/invitation; API credentials cannot read ciphertext. Delivery rechecks invitation and inviter authorization.
- Stable provider idempotency keys, shared email budgets, bounded retries, 20-hour expiry jobs and maintenance cleanup protect against replay and retained raw links. Acceptance/revocation clears queued content.
- Desktop People shows queued/provider-accepted/failure status and retains the one-time copy link. Provider acceptance is not confirmation of inbox delivery.
- Verification: 85 backend tests and three desktop journeys pass, along with type checking, lint, formatting and production build. React Doctor reports the same existing advisories; the People screen was visually checked.
- See [configuration and staging release gates](invitation-email.md). Live provider sending remains unverified.

## Phase 2 next work, in dependency order

1. Validate the new membership flows against the real staging Supabase project, including password reauthentication and invitation onboarding.
2. Validate desktop project workflows with club members, including terminology and search behavior. Organization-wide search and label rename/removal remain pending; project-scoped search and desktop drag/keyboard ordering are implemented.
3. Deploy and verify the worker/inbox and opt-in invitation email with authorized staging recipients. Assignment and invitation mail adapters and durable processing are implemented; actual provider delivery remains unverified.
4. Verify the attachment provider flow in staging and complete independent object backup and restore rehearsal. Metadata, quotas, transfer UI and worker validation/cleanup are implemented.
5. Validate overview, templates and exports with club members; configure the private export bucket and verify real-provider expiry/cleanup. The features are implemented; hosted verification remains pending.
6. Recovery rehearsal, accessibility review, threat-model tests, and a small internal pilot before 50-member rollout.

## Deliberately not implemented

Sprints, private projects, configurable workflows, billing, OAuth beyond email, editable templates, external integrations, Redis, dedicated search, WebSockets, replicas, sharding, and microservices remain in their original later/demand-only phases. There is no fake production authentication or demo-data fallback.

## Current limits to carry forward

- Organization/member/project listings are capped at 100 for the small internal foundation; full pagination/quotas must ship before larger onboarding. Task pagination and project-wide server search are implemented.
- Issue detail/priority/assignee/due-date editing and labels now have UI. Comments and attachments now have UI. Live storage configuration and backup rehearsal remain pending.
- This increment uses parameterized `pg` queries rather than adding an unused query-builder layer; it follows the plan's PostgreSQL/explicit-transaction approach.
- A real consumer is now implemented. Hosted deployment, live email and alert destinations still require staging configuration; in-app tests do not prove provider delivery.
- Idempotency records are retained until maintenance is implemented. The service currently gives stronger retry retention than the architecture's proposed 24-hour window; retention cleanup must not delete records while requests are active.
- Task views sort by numeric rank and UUID. Cursors resolve a tenant/project-scoped issue anchor; these are live views, not snapshots. Concurrent movement can change page boundaries; clients invalidate and refetch after writes, and missing anchors require refresh.
- New issue updates record changed operational fields, label IDs, and description-change markers. Earlier activity rows retain their original, more limited payloads. Membership offboarding events remain intact.
- Membership mutations now take an exclusive organization advisory lock matching the shared authorization lock in `withTenant`. This avoids grant escalation merely to use SQL row locks during bootstrap reads.
- API logout denylisting covers 24 hours; configure provider access-token lifetime to 30 minutes and never above that window. Logout-all and session-management UI are not shipped yet.
- The test binary packaging tool has a beta version suffix; the PostgreSQL binary is a stable PostgreSQL 17 release. This is development-only tooling and not the production database/runtime.
