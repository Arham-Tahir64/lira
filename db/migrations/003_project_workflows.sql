CREATE TABLE app.labels (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES app.organizations(id),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 40), color text NOT NULL DEFAULT '#6853cc',
 UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX labels_name ON app.labels(org_id,lower(trim(name)));
CREATE TABLE app.issue_labels (
 org_id uuid NOT NULL, issue_id uuid NOT NULL, label_id uuid NOT NULL,
 PRIMARY KEY(org_id,issue_id,label_id),
 FOREIGN KEY(org_id,issue_id) REFERENCES app.issues(org_id,id),
 FOREIGN KEY(org_id,label_id) REFERENCES app.labels(org_id,id)
);
ALTER TABLE app.labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.labels FORCE ROW LEVEL SECURITY;
ALTER TABLE app.issue_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.issue_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.labels TO app_api USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());
CREATE POLICY tenant_scope ON app.issue_labels TO app_api USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());
GRANT SELECT,INSERT ON app.labels TO app_api;
GRANT SELECT,INSERT,DELETE ON app.issue_labels TO app_api;
ALTER TABLE app.issues ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
 setweight(to_tsvector('english',title),'A') || setweight(to_tsvector('english',description),'B')
) STORED;
CREATE INDEX issue_search ON app.issues USING gin(search_vector);
CREATE INDEX issue_rank ON app.issues(org_id,project_id,rank,id);
CREATE INDEX activity_project ON app.activity_events(org_id,project_id,id);
