CREATE TABLE app.invitation_emails (
 org_id uuid NOT NULL,invitation_id uuid NOT NULL,event_id uuid NOT NULL UNIQUE,
 encrypted_payload text CHECK(length(encrypted_payload)<=20000),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sent','cancelled','expired','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '20 hours',sent_at timestamptz,
 PRIMARY KEY(org_id,invitation_id),
 FOREIGN KEY(org_id,invitation_id) REFERENCES app.invitations(org_id,id),
 FOREIGN KEY(org_id,event_id) REFERENCES app.activity_events(org_id,id)
);
CREATE INDEX invitation_email_expiry ON app.invitation_emails(expires_at) WHERE encrypted_payload IS NOT NULL;
ALTER TABLE app.invitation_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invitation_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_email_tenant ON app.invitation_emails TO app_api,app_worker USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());
GRANT INSERT ON app.invitation_emails TO app_api;
GRANT SELECT(org_id,invitation_id,event_id,state,created_at,expires_at,sent_at),UPDATE(state,encrypted_payload) ON app.invitation_emails TO app_api;
GRANT SELECT,UPDATE ON app.invitation_emails TO app_worker;
GRANT SELECT ON app.invitations TO app_worker;
CREATE POLICY invitation_worker_tenant ON app.invitations TO app_worker USING(org_id=app.current_org_id());
