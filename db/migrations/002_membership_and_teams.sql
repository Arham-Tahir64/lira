ALTER TABLE app.memberships ADD COLUMN display_name text NOT NULL DEFAULT coalesce(nullif(current_setting('app.display_name',true),''),'Member') CHECK(length(display_name) BETWEEN 1 AND 100);
ALTER TABLE app.memberships ADD COLUMN left_at timestamptz;
UPDATE app.memberships m SET display_name=u.display_name FROM app.users u WHERE u.id=m.user_id;
GRANT INSERT,UPDATE ON app.memberships TO app_api;
CREATE POLICY membership_insert ON app.memberships FOR INSERT TO app_api WITH CHECK(org_id=app.current_org_id());
CREATE POLICY membership_update ON app.memberships FOR UPDATE TO app_api USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id());

CREATE TABLE app.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES app.organizations(id),
  email text NOT NULL CHECK(email=lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  role text NOT NULL CHECK(role IN ('admin','member')), token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  inviter_membership_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', accepted_at timestamptz, revoked_at timestamptz,
  CHECK(expires_at>created_at), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,inviter_membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE UNIQUE INDEX one_pending_invite_per_email ON app.invitations(org_id,email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitation_org_created ON app.invitations(org_id,created_at,id);
CREATE TABLE app.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES app.organizations(id),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX team_name_per_org ON app.teams(org_id,lower(trim(name)));
CREATE TABLE app.team_members (
  org_id uuid NOT NULL, team_id uuid NOT NULL, membership_id uuid NOT NULL,
  PRIMARY KEY(org_id,team_id,membership_id),
  FOREIGN KEY(org_id,team_id) REFERENCES app.teams(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,membership_id) REFERENCES app.memberships(org_id,id)
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['invitations','teams','team_members'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_scope ON app.%I TO app_api USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id())',table_name);
  END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON app.invitations TO app_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.teams,app.team_members TO app_api;

-- Organization events need neither a project nor an issue, but any supplied references remain tenant-bound.
ALTER TABLE app.activity_events ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE app.activity_events ALTER COLUMN issue_id DROP NOT NULL;
ALTER TABLE app.activity_events ADD CONSTRAINT activity_project_fk FOREIGN KEY(org_id,project_id) REFERENCES app.projects(org_id,id);
ALTER TABLE app.activity_events ADD CONSTRAINT activity_issue_requires_project CHECK(issue_id IS NULL OR project_id IS NOT NULL);

CREATE ROLE app_invitation_accept NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO app_invitation_accept;
GRANT EXECUTE ON FUNCTION app.current_user_id(),app.current_org_id() TO app_invitation_accept;
GRANT SELECT,UPDATE ON app.invitations TO app_invitation_accept;
GRANT SELECT,INSERT,UPDATE ON app.memberships TO app_invitation_accept;
CREATE POLICY invite_accept_lookup ON app.invitations TO app_invitation_accept USING(true) WITH CHECK(true);
CREATE POLICY invite_accept_membership ON app.memberships TO app_invitation_accept USING(true) WITH CHECK(user_id=app.current_user_id());
-- This role is reachable only through this bounded function, never as a runtime membership.
CREATE FUNCTION app.accept_invitation(p_hash text,p_verified_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE invitation app.invitations; existing app.memberships;
BEGIN
  SELECT * INTO invitation FROM app.invitations WHERE token_hash=p_hash;
  IF invitation.id IS NULL OR app.current_user_id() IS NULL THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='P0002'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(invitation.org_id::text,1));
  SELECT * INTO invitation FROM app.invitations WHERE id=invitation.id FOR UPDATE;
  IF invitation.email<>p_verified_email OR invitation.accepted_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=now() THEN
    RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='P0002';
  END IF;
  -- Outstanding invitations cannot retain a privilege that the inviter no longer holds.
  IF NOT EXISTS(SELECT 1 FROM app.memberships WHERE id=invitation.inviter_membership_id AND org_id=invitation.org_id AND state='active' AND (role='owner' OR (role='admin' AND invitation.role='member'))) THEN
    RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO existing FROM app.memberships WHERE org_id=invitation.org_id AND user_id=app.current_user_id();
  IF existing.state='active' THEN RAISE EXCEPTION 'Already a member' USING ERRCODE='P0003'; END IF;
  IF (SELECT count(*) FROM app.memberships WHERE org_id=invitation.org_id AND state='active')>=100 THEN RAISE EXCEPTION 'Workspace member limit reached' USING ERRCODE='P0001'; END IF;
  INSERT INTO app.memberships(org_id,user_id,role,display_name)
    VALUES(invitation.org_id,app.current_user_id(),invitation.role,coalesce(nullif(current_setting('app.display_name',true),''),'Member'))
    ON CONFLICT(org_id,user_id) DO UPDATE SET state='active',role=excluded.role,display_name=excluded.display_name,left_at=NULL;
  UPDATE app.invitations SET accepted_at=now() WHERE id=invitation.id;
  RETURN invitation.org_id;
END $$;
ALTER FUNCTION app.accept_invitation(text,text) OWNER TO app_invitation_accept;
REVOKE ALL ON FUNCTION app.accept_invitation(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_invitation(text,text) TO app_api;

-- Defense in depth: the last owner invariant also applies to direct SQL updates.
CREATE ROLE app_owner_guard NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO app_owner_guard;
GRANT SELECT ON app.memberships TO app_owner_guard;
CREATE POLICY owner_guard_read ON app.memberships FOR SELECT TO app_owner_guard USING(true);
CREATE FUNCTION app.enforce_last_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF OLD.role='owner' AND OLD.state='active' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(OLD.org_id::text,1));
    IF NOT EXISTS(SELECT 1 FROM app.memberships WHERE org_id=OLD.org_id AND role='owner' AND state='active') THEN
      RAISE EXCEPTION 'Workspace must retain an active owner' USING ERRCODE='P0004';
    END IF;
  END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION app.enforce_last_owner() OWNER TO app_owner_guard;
REVOKE ALL ON FUNCTION app.enforce_last_owner() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER retain_owner AFTER UPDATE OR DELETE ON app.memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.enforce_last_owner();
