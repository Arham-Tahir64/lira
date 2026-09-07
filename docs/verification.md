# Verification record

## Checks for the foundation and membership increments

- The foundation GitHub CI run passed, including Linux tests and Docker build: [run 33983539392](https://github.com/Arham-Tahir64/lira/actions/runs/33983539392).
- TypeScript type checking and ESLint pass.
- Real PostgreSQL integration checks exercise restricted runtime roles, RLS without application filters, context reuse/rollback, composite foreign keys, authorization, concurrent creates, idempotency, stale updates, inactive/disabled users, and logout.
- Authentication tests use generated asymmetric signing keys and a local provider fixture to verify signature/issuer/audience/expiry handling and authoritative email verification.
- Playwright desktop and mobile checks cover sign-in, task creation, status update, board view, dialog Escape handling, and horizontal overflow. Provider/API responses are test fixtures; this verifies UI behavior separately from the real SQL/API tests.
- Desktop/mobile screenshots were visually inspected. No clipped content or horizontal page overflow was found in the tested flow.
- The production frontend and API builds pass. Docker is unavailable on the implementation machine, so the container build is configured as a required CI step and is not claimed as locally tested.

## React Doctor review

The scanner identified missing explicit submit types, which were corrected. Remaining complexity warnings concern three feature screens; the screens have been separated from session lifecycle and shared primitives. Further decomposition is reasonable as Phase 2 adds functionality. The filter/map warning applies to at most 100 items per fetched page and is not a measured performance problem; avoid obscuring simple rendering logic solely to satisfy it.

The browser-artifact authority-map warning is reviewed as expected public configuration/contract exposure, not an authorization mechanism: the browser receives only a publishable/anon key, performs no direct domain database calls, and all roles/tenant boundaries are enforced by the API plus PostgreSQL RLS and composite foreign keys. Startup rejects privileged Supabase keys. No warning rule was disabled to hide this result.

## Not yet verified

Real club Supabase configuration, actual SMTP delivery/PKCE redirects, hosted migration privileges, deployed TLS/network access, backup restoration, and a production container run remain separate staging/release gates. No claim is made that the complete MVP or commercial launch is ready.

## Membership coverage

The combined suite passes 35 API/database/identity tests and four desktop/mobile browser tests. The final React Doctor scan reports five advisory warnings (67/100); the team-member lookup warning was corrected with a set. The remaining findings are assessed above.

After that verification, the user changed the product priority to laptop/desktop first. `npm run test:e2e` now runs the two desktop journeys as the release gate. The existing mobile project is optional (`npx playwright test --project=mobile`); mobile-specific verification is no longer required for new work.

PostgreSQL tests also cover email normalization/binding, simultaneous invite acceptance, expired/revoked invites, reduced inviter privileges, stale authentication, direct-SQL last-owner protection, concurrent owner demotions, ownership transfer, tenant-scoped team membership, offboarding cleanup, and replay of consumed invitations after removal. UI tests cover creating a shareable invite, managing a team, password-confirmed role changes, and fragment-based invitation capture/acceptance on desktop and mobile.

Do not interpret UI provider fixtures as staging SMTP/reauthentication verification. Those gates remain open until a real Supabase project is configured.

## Project workflow increment

The real PostgreSQL suite now has 39 tests. Added checks exercise indexed text/exact-key search with filters, cross-tenant labels and composite foreign keys, rejected-update rollback, operational history without description bodies, concurrent/versioned moves, small-gap rebalancing, per-status cursor pagination, archive permissions, and chronological activity pages. The two desktop browser journeys include full task edits, assignment and label persistence after reopening, server-search requests, activity, and archive/restore controls. The fixtures verify UI behavior; real SQL/API tests verify enforcement.

React Doctor findings were reviewed against the code. Error notices now have stable rendering rather than filtered array-index keys. Component complexity and bounded filter/map chains remain maintainability advisories, not demonstrated correctness failures. Board columns, task editing, and history live in separate components. Public Supabase configuration remains identity-only; no new direct domain-database access was introduced.

Search performance at production data volume is not benchmarked. The generated vector and GIN/B-tree indexes are installed and queries run in real PostgreSQL tests; representative EXPLAIN ANALYZE/load testing remains a beta gate. Search uses English stemming and exact issue keys, not fuzzy or substring matching. The workflow branch CI and deployed-provider validation are separate checks.

## Worker and inbox increment

The PostgreSQL/identity/worker suite passes 51 tests. New checks exercise runtime-role separation, concurrent claims, lease replacement and stale acknowledgment, in-app deduplication and recipient RLS, wrong-tenant jobs, removal/reassignment checks, independent in-app commit, immutable mail retries, missing mail configuration, opt-out and age limits, daily budgets, failed states, and provider error sanitization. The two desktop journeys additionally cover inbox display, preferences, marking read and filtering unread. The inbox screenshot was visually reviewed.

Email tests use fake transport; no external recipient was contacted. Real Resend delivery, hosted worker termination/recovery and an authorized retention rehearsal remain staging gates.

Retention checks also verify that preview mode is read-only, old rows are removed only in apply mode, and pending jobs survive cleanup. React Doctor reports advisory complexity and bounded-iteration findings; the new inbox introduces no direct domain database access or scanner bug findings.

## Task board and attachment increments

The task-board/comment increment passed 54 backend tests and two desktop browser scenarios. The attachment increment expands the suite to 64 tests: real PostgreSQL checks cover concurrent quota reservations, idempotent upload reservations, tenant RLS and composite references, upload ownership, revoked membership, archived projects, checksum/signature rejection, expiry, deletion during validation, stale worker leases, retryable provider deletion, and preserving failed cleanup jobs. Adapter tests cover bucket privacy, path validation, signed transfer parameters and bounded reads. Provider traffic is a fixture; no live files were uploaded.

The desktop workspace scenario now exercises file selection, SHA-256 reservation, direct transfer without an application bearer token, quarantine UI, ready download and removal. Attachment layout was visually reviewed at desktop size. Type checking, lint, formatting and build are release checks. React Doctor's array-index notice finding was corrected with stable error rendering; bounded list iteration and existing component-complexity warnings remain advisories. The browser Supabase client still handles identity only; domain metadata goes through Fastify and file bytes through scoped storage capabilities. The main bundle remains above Vite's advisory 500 kB threshold.

Live provider restrictions, capability expiry, overwrite behavior, download disposition and independent object restore remain explicit staging gates in the attachment runbook. Malware scanning is not present; outside-club uploads are disabled.
