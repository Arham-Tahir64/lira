CREATE TABLE app.comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,project_id uuid NOT NULL,issue_id uuid NOT NULL,
 author_membership_id uuid NOT NULL,body text NOT NULL CHECK(length(body)<=10000),version integer NOT NULL DEFAULT 1,
 client_key uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),edited_at timestamptz,deleted_at timestamptz,
 UNIQUE(org_id,author_membership_id,client_key),
 FOREIGN KEY(org_id,project_id,issue_id) REFERENCES app.issues(org_id,project_id,id),
 FOREIGN KEY(org_id,author_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE INDEX comments_issue ON app.comments(org_id,issue_id,created_at,id);
ALTER TABLE app.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comments FORCE ROW LEVEL SECURITY;
CREATE POLICY comment_tenant ON app.comments TO app_api USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());
GRANT SELECT,INSERT,UPDATE ON app.comments TO app_api;
