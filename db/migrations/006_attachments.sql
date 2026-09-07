CREATE TABLE app.attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, project_id uuid NOT NULL, issue_id uuid NOT NULL,
 uploader_membership_id uuid NOT NULL, client_key uuid NOT NULL,
 object_key text NOT NULL UNIQUE, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180),
 media_type text NOT NULL CHECK(media_type IN ('application/pdf','image/png','image/jpeg','text/plain')),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760), checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'),
 charged_bytes integer NOT NULL DEFAULT 10485760 CHECK(charged_bytes BETWEEN 1 AND 10485760),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','quarantined','ready','deleting','deleted')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 delete_after timestamptz NOT NULL DEFAULT now()+interval '3 hours', rejection text,
 UNIQUE(org_id,uploader_membership_id,client_key),
 FOREIGN KEY(org_id,project_id,issue_id) REFERENCES app.issues(org_id,project_id,id),
 FOREIGN KEY(org_id,uploader_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE INDEX attachments_issue ON app.attachments(org_id,issue_id,created_at,id);
CREATE INDEX attachments_quota ON app.attachments(org_id,state) WHERE state<>'deleted';
ALTER TABLE app.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachment_tenant ON app.attachments TO app_api,app_worker USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());
GRANT SELECT,INSERT,UPDATE ON app.attachments TO app_api;
GRANT SELECT,UPDATE ON app.attachments TO app_worker;
