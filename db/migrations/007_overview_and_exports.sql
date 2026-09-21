ALTER TABLE app.projects ADD COLUMN term text NOT NULL DEFAULT '' CHECK(length(term)<=60), ADD COLUMN template_id text CHECK(template_id IN ('event','semester'));
CREATE INDEX issues_dashboard ON app.issues(org_id,assignee_membership_id,due_date,id) WHERE status<>'done';
CREATE TABLE app.exports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL REFERENCES app.organizations(id),requester_membership_id uuid NOT NULL,
 client_key uuid NOT NULL,object_key text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed','expired')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 snapshot_at timestamptz,bytes integer,checksum text,failure text,
 UNIQUE(org_id,requester_membership_id,client_key),
 FOREIGN KEY(org_id,requester_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE INDEX exports_org ON app.exports(org_id,created_at DESC,id DESC);
ALTER TABLE app.exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.exports FORCE ROW LEVEL SECURITY;
CREATE POLICY export_tenant ON app.exports TO app_api,app_worker USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());
GRANT SELECT,INSERT ON app.exports TO app_api;
GRANT SELECT,UPDATE ON app.exports TO app_worker;
GRANT SELECT ON app.organizations,app.boards,app.teams,app.team_members,app.labels,app.issue_labels,app.comments TO app_worker;
CREATE POLICY worker_org ON app.organizations TO app_worker USING(id=app.current_org_id());
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['boards','teams','team_members','labels','issue_labels','comments'] LOOP
  EXECUTE format('CREATE POLICY export_worker_tenant ON app.%I TO app_worker USING(org_id=app.current_org_id())',t);
 END LOOP;
END $$;
