# Lira

A lightweight, multi-tenant project workspace for student clubs. Built against the accepted [software architecture](docs/software-architecture.md).

**Status: Phase 1 implementation in progress.** The repository contains a working foundation and a tested task-management vertical slice. It is not ready for external club data or a paid launch. See [phase gates and next work](docs/implementation-status.md).

## Implemented

- React/Vite/TypeScript workspace with Supabase signup, verified-email sign-in, password recovery, workspace switching, project creation, task list/backlog/board views, and keyboard-accessible task status changes.
- Fastify REST API with shared TypeBox contracts, generated OpenAPI, strict input validation, response allowlists for tasks, role checks, and restricted public configuration.
- PostgreSQL tenant isolation with transaction-local context, forced RLS, composite foreign keys, separate bootstrap/runtime roles, and fail-closed startup credential checks.
- Atomic task/activity/outbox creation, concurrent issue numbering, idempotent task creation, versioned updates, and bounded task pagination.
- Real PostgreSQL integration tests, signed-token verification tests, desktop/mobile UI tests, CI, and a production container definition.

## Start locally

Use Node 24 and npm. Docker is needed for the local Supabase stack; the database/API integration tests can run without Docker using temporary PostgreSQL binaries.

```sh
npm ci
```

Follow [local setup](docs/local-development.md) to start Supabase, provision the restricted database login, and supply configuration. Then:

```sh
npm run dev
```

Open http://localhost:5173. The UI uses real API data; there is no production demo mode or authentication bypass. Test-only provider fixtures exist only in test files.

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

`npm test` starts a disposable native PostgreSQL 17 instance on an available loopback port, applies real SQL migrations, and connects as a restricted runtime login. CI uses an isolated PostgreSQL service instead. Never point `TEST_ADMIN_DATABASE_URL` at an existing or production database.

## Structure

- `apps/web`: React workspace.
- `apps/server`: Fastify application; identity, database boundary, and project/task services.
- `packages/contracts`: shared validation/response schemas and TypeScript contracts.
- `db/migrations`: versioned SQL, constraints, roles, and policies.
- `scripts`: migrations, role provisioning, test database setup.
- `docs`: accepted architecture, implementation status, development, and operational notes.

The browser calls Supabase for identity only and uses the API for all domain data. Application organizations share one infrastructure database; never create a Supabase project per club. Do not expose the `app` schema through the Supabase Data API.

## Production configuration

See [deployment](docs/deployment.md). No services are provisioned or published automatically. Container startup requires real configuration and rejects an owner/superuser database connection. Outbox rows are durable but intentionally **not consumed yet**; notification delivery and the worker belong to Phase 2.
