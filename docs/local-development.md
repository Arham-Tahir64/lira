# Local development

## Prerequisites

Node 24, npm, Docker Desktop (or compatible Docker runtime) for Supabase, and the Supabase CLI. Do not reuse production data for development.

1. Run `npm ci` at the repository root.
2. Run `npx supabase init`, then `npx supabase start` at the repository root. Keep generated local service state out of commits. This follows the official [local development workflow](https://supabase.com/docs/guides/local-development).
3. In the generated `supabase/config.toml`, set Auth's site URL and allowed redirects to `http://localhost:5173`, enable email confirmations, and use the local mail inbox shown by the CLI to open verification/recovery links. Require an asymmetric ES256/RS256 JWT signing key; legacy HS256 is intentionally rejected by this API. Use current supported local Auth configuration or a separate development Supabase project if the CLI's signing mode differs.
4. Copy the database connection URL, Auth URL, and publishable (or legacy anonymous/public) key reported by your own local instance into your shell environment. Never use a service-role key as `SUPABASE_PUBLIC_KEY`.

```sh
export MIGRATION_DATABASE_URL='postgresql://postgres:YOUR_LOCAL_PASSWORD@127.0.0.1:54322/postgres'
export SUPABASE_URL='http://127.0.0.1:54321'
export SUPABASE_PUBLIC_KEY='YOUR_LOCAL_PUBLISHABLE_KEY'
npm run db:migrate
```

Migration credentials must be allowed to create the two restricted roles and transfer function ownership. Provision a separate application login once:

```sh
export APP_DATABASE_PASSWORD='CHOOSE_A_LOCAL_DATABASE_PASSWORD'
npm run db:provision-login
```

Then configure the API with that login, not the migration owner:

```sh
export DATABASE_URL='postgresql://lira_api:URL_ENCODED_LOCAL_PASSWORD@127.0.0.1:54322/postgres'
unset MIGRATION_DATABASE_URL APP_DATABASE_PASSWORD
npm run dev
```

API: http://127.0.0.1:3000. UI: http://localhost:5173. OpenAPI: http://127.0.0.1:3000/api/openapi.json. Use the same browser origin consistently for PKCE redirects; `localhost` and `127.0.0.1` are different origins. The dev server binds loopback and proxies `/api` to port 3000.

Create an account, open the local verification email, sign in, create a workspace/project, and create/update a task. The default Auth metadata cannot bypass email verification. Never add a production `DEV_AUTH` flag to make local setup appear to work.

## Database tests without Docker

`npm test` provisions a fresh, disposable native PostgreSQL cluster on an available localhost port and removes it afterward. The native package supports common macOS/Linux architectures; unsupported machines can set `TEST_ADMIN_DATABASE_URL` to a fresh dedicated PostgreSQL test database. The setup creates roles and tables, so an ordinary application login is insufficient for setup. Actual test requests run as a separate `NOSUPERUSER NOBYPASSRLS` login.

The test suite calls native binaries directly because the embedded wrapper's process-exit hook can override a failing test exit code. Never import that wrapper into the test-runner process. CI uses the PostgreSQL service without this wrapper.

## Schema changes

Add a new numbered migration; never modify an applied migration. The runner records checksums and holds an advisory lock. The first migration is intentionally not idempotent outside the runner: role/table conflicts should fail rather than silently adopt unknown existing permissions. Test migrations on a fresh database and a previous schema snapshot.

Supabase platform roles and production network settings can differ from local superuser setup. Confirm the first migration and role provisioning in an empty staging project before touching production. Exclude the `app` schema from the Supabase Data API and do not grant browser roles any access to it.

## Overview and templates

After applying migration 007, select **Workspace overview** in the sidebar. **Create project** offers two bundled templates and an optional semester label. These use the existing database/API configuration. Background exports additionally need the private JSON bucket and worker configuration in [overview and exports](overview-and-exports.md).
