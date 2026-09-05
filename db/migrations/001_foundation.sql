-- Runtime logins inherit app_api. Neither owns tables nor bypasses RLS.
CREATE ROLE app_api NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO app_api, app_bootstrap;

CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app.current_org_id() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION app.current_user_id(), app.current_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.current_org_id() TO app_api, app_bootstrap;

CREATE TABLE app.users (
  id uuid PRIMARY KEY, auth_subject uuid UNIQUE NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  disabled_at timestamptz, sessions_revoked_before timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 48),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES app.organizations(id),
  user_id uuid NOT NULL REFERENCES app.users(id),
  role text NOT NULL CHECK(role IN ('owner','admin','member')),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id), UNIQUE(org_id,user_id)
);
CREATE TABLE app.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES app.organizations(id),
  key text NOT NULL CHECK(key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '',
  lead_membership_id uuid NOT NULL,
  next_issue_number integer NOT NULL DEFAULT 1 CHECK(next_issue_number > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id), UNIQUE(org_id,key),
  FOREIGN KEY(org_id,lead_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE TABLE app.boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
  project_id uuid NOT NULL, name text NOT NULL DEFAULT 'Board',
  UNIQUE(org_id,project_id),
  FOREIGN KEY(org_id,project_id) REFERENCES app.projects(org_id,id)
);
CREATE TABLE app.issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
  project_id uuid NOT NULL, number integer NOT NULL CHECK(number > 0),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '' CHECK(length(description) <= 20000),
  status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in_progress','done')),
  planning_state text NOT NULL DEFAULT 'planned' CHECK(planning_state IN ('backlog','planned')),
  priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  assignee_membership_id uuid, creator_membership_id uuid NOT NULL,
  due_date date, rank numeric NOT NULL, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id), UNIQUE(org_id,project_id,id), UNIQUE(org_id,project_id,number),
  CHECK(status <> 'done' OR planning_state = 'planned'),
  FOREIGN KEY(org_id,project_id) REFERENCES app.projects(org_id,id),
  FOREIGN KEY(org_id,assignee_membership_id) REFERENCES app.memberships(org_id,id),
  FOREIGN KEY(org_id,creator_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE TABLE app.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
  project_id uuid NOT NULL, issue_id uuid NOT NULL, actor_membership_id uuid NOT NULL,
  action text NOT NULL, changes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,project_id,issue_id) REFERENCES app.issues(org_id,project_id,id),
  FOREIGN KEY(org_id,actor_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE TABLE app.outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES app.organizations(id),
  event_id uuid NOT NULL UNIQUE,
  type text NOT NULL, payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','completed','failed')),
  attempts integer NOT NULL DEFAULT 0, run_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,event_id) REFERENCES app.activity_events(org_id,id)
);
CREATE TABLE app.idempotency_records (
  org_id uuid NOT NULL REFERENCES app.organizations(id), user_id uuid NOT NULL REFERENCES app.users(id),
  operation text NOT NULL, key uuid NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,user_id,operation,key)
);
CREATE INDEX memberships_by_user ON app.memberships(user_id,state);
CREATE INDEX issue_board ON app.issues(org_id,project_id,planning_state,status,rank,id);
CREATE INDEX issue_assignee ON app.issues(org_id,assignee_membership_id,status,due_date);
CREATE INDEX outbox_ready ON app.outbox_jobs(run_at) WHERE state = 'pending';
CREATE INDEX activity_issue ON app.activity_events(org_id,issue_id,created_at,id);

ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY own_user ON app.users TO app_api USING(id = app.current_user_id()) WITH CHECK(id = app.current_user_id() AND auth_subject = app.current_user_id());
ALTER TABLE app.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_scope ON app.organizations TO app_api USING(id = app.current_org_id());
ALTER TABLE app.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON app.memberships FOR SELECT TO app_api USING(org_id = app.current_org_id() OR user_id = app.current_user_id());
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['projects','boards','issues','activity_events','outbox_jobs','idempotency_records'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON app.%I TO app_api USING(org_id = app.current_org_id()) WITH CHECK(org_id = app.current_org_id())',table_name);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON app.users TO app_api;
GRANT SELECT ON app.organizations,app.memberships TO app_api;
GRANT SELECT,INSERT,UPDATE ON app.projects,app.issues TO app_api;
GRANT SELECT,INSERT ON app.boards,app.activity_events,app.outbox_jobs,app.idempotency_records TO app_api;
-- Append-only event/outbox records cannot be modified by request handlers.

-- A narrowly scoped bootstrap role can create a tenant and its first membership.
GRANT SELECT,INSERT ON app.organizations,app.memberships TO app_bootstrap;
CREATE POLICY bootstrap_org ON app.organizations TO app_bootstrap USING(true) WITH CHECK(true);
CREATE POLICY bootstrap_membership ON app.memberships TO app_bootstrap USING(user_id = app.current_user_id()) WITH CHECK(user_id = app.current_user_id() AND role = 'owner');
CREATE FUNCTION app.create_organization(p_name text,p_slug text) RETURNS app.organizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,app AS $$
DECLARE created app.organizations;
BEGIN
  IF app.current_user_id() IS NULL THEN RAISE EXCEPTION 'Identity required' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(app.current_user_id()::text,0));
  IF (SELECT count(*) FROM app.memberships WHERE user_id = app.current_user_id() AND role = 'owner') >= 3 THEN
    RAISE EXCEPTION 'Organization creation limit reached' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.organizations(name,slug) VALUES(p_name,p_slug) RETURNING * INTO created;
  INSERT INTO app.memberships(org_id,user_id,role) VALUES(created.id,app.current_user_id(),'owner');
  RETURN created;
END $$;
ALTER FUNCTION app.create_organization(text,text) OWNER TO app_bootstrap;
REVOKE ALL ON FUNCTION app.create_organization(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_organization(text,text) TO app_api;
-- A user's workspace switcher can read only organizations with an active own membership.
CREATE POLICY own_organizations ON app.organizations FOR SELECT TO app_api USING(EXISTS(SELECT 1 FROM app.memberships m WHERE m.org_id=organizations.id AND m.user_id=app.current_user_id() AND m.state='active'));
CREATE TABLE app.revoked_sessions (
  session_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app.users(id),
  expires_at timestamptz NOT NULL
);
ALTER TABLE app.revoked_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.revoked_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY own_sessions ON app.revoked_sessions TO app_api USING(user_id=app.current_user_id()) WITH CHECK(user_id=app.current_user_id());
GRANT SELECT,INSERT ON app.revoked_sessions TO app_api;
