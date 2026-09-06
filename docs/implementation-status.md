# Implementation status

Reference: [accepted architecture](software-architecture.md), particularly Sections 14–16. This file records progress; it does not replace or broaden the architecture.

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

## Current increment: Phase 2 membership and teams

- Email-bound, single-use, seven-day invitation links; only token hashes are stored. Creation/revocation requires an administrator, and Admin invitations require an Owner.
- Invitation acceptance checks current inviter permissions, expiry/revocation, the verified recipient email, and the 100-active-member pilot cap atomically.
- A People & Teams screen supports invitation creation, role changes, member removal/leave, ownership transfer, and team membership.
- Ownership/role changes require a recent signed provider authentication method timestamp; token refresh does not qualify. The UI asks for the current password through Supabase before sensitive changes.
- Membership writes serialize with normal tenant requests. Removal clears open assignments, increments issue versions, removes team links, revokes outstanding invites created by the departing member, and reassigns project leads to an active owner. Historical attribution remains.
- A deferred PostgreSQL trigger prevents removal/demotion of the final owner even through direct SQL. Teams are organizational groups and grant no project permissions.
- Invitations currently provide a one-time link for the administrator to share. No automatic email is sent; email delivery is pending the planned worker step. Organization activity is persisted; notification delivery is not implied.

## Phase 2 next work, in dependency order

1. Validate the new membership flows against the real staging Supabase project, including password reauthentication and invitation onboarding.
2. Complete issue editing/assignment UI, labels, search, ordered movement and bounded board-column pagination; project archiving and operational activity UI.
3. Durable worker claiming/leases, retries, idempotent in-app notifications, email provider adapter; current pending outbox events remain unconsumed until this ships.
4. Comments and attachment metadata/quotas, private storage transfer/validation, independent object backup.
5. Basic dashboard, two bundled student-club templates, organization export.
6. Recovery rehearsal, accessibility review, threat-model tests, and a small internal pilot before 50-member rollout.

## Deliberately not implemented

Sprints, private projects, configurable workflows, billing, OAuth beyond email, editable templates, external integrations, Redis, dedicated search, WebSockets, replicas, sharding, and microservices remain in their original later/demand-only phases. There is no fake production authentication or demo-data fallback.

## Current limits to carry forward

- Organization/member/project listings are capped at 100 for the small internal foundation; full pagination/quotas must ship before larger onboarding. Task pagination is implemented; the current local filter explicitly searches loaded tasks only.
- UI edits status; the API also supports detail/priority/assignee/due-date edits. UI assignment, comments, and uploads remain Phase 2; invitations and roster/team management now have UI.
- This increment uses parameterized `pg` queries rather than adding an unused query-builder layer; it follows the plan's PostgreSQL/explicit-transaction approach.
- Durable outbox records are not a claim of notification delivery. Worker deployment will be added alongside a real consumer.
- Idempotency records are retained until maintenance is implemented. The service currently gives stronger retry retention than the architecture's proposed 24-hour window; retention cleanup must not delete records while requests are active.
- Task views sort by UUID for stable cursor pagination. Stored ranks and the planned movement/rebalancing behavior are not exposed yet.
- Activity payloads currently record status and priority. Full operational field history is required before calling the MVP activity feature complete.
- Membership mutations now take an exclusive organization advisory lock matching the shared authorization lock in `withTenant`. This avoids grant escalation merely to use SQL row locks during bootstrap reads.
- API logout denylisting covers 24 hours; configure provider access-token lifetime to 30 minutes and never above that window. Logout-all and session-management UI are not shipped yet.
- The test binary packaging tool has a beta version suffix; the PostgreSQL binary is a stable PostgreSQL 17 release. This is development-only tooling and not the production database/runtime.
