CREATE ROLE app_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_scheduler NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO app_worker,app_scheduler;
GRANT EXECUTE ON FUNCTION app.current_org_id() TO app_worker;
ALTER TABLE app.users ADD COLUMN verified_email text, ADD COLUMN email_verified_at timestamptz;
GRANT UPDATE(verified_email,email_verified_at) ON app.users TO app_api;
CREATE TABLE app.notification_preferences (
 org_id uuid NOT NULL, membership_id uuid NOT NULL, assignment_email boolean NOT NULL DEFAULT false,
 PRIMARY KEY(org_id,membership_id), FOREIGN KEY(org_id,membership_id) REFERENCES app.memberships(org_id,id)
);
CREATE TABLE app.notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid NOT NULL,recipient_membership_id uuid NOT NULL,
 event_id uuid NOT NULL,project_id uuid NOT NULL,issue_id uuid NOT NULL,
 type text NOT NULL CHECK(type='issue.assigned'),read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,event_id,recipient_membership_id),
 FOREIGN KEY(org_id,recipient_membership_id) REFERENCES app.memberships(org_id,id),
 FOREIGN KEY(org_id,event_id) REFERENCES app.activity_events(org_id,id),
 FOREIGN KEY(org_id,project_id,issue_id) REFERENCES app.issues(org_id,project_id,id)
);
CREATE INDEX notifications_inbox ON app.notifications(org_id,recipient_membership_id,created_at DESC,id DESC);
CREATE TABLE app.email_deliveries (
 org_id uuid NOT NULL, event_id uuid NOT NULL, recipient_membership_id uuid NOT NULL,
 request jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 PRIMARY KEY(org_id,event_id,recipient_membership_id),
 FOREIGN KEY(org_id,event_id) REFERENCES app.activity_events(org_id,id),
 FOREIGN KEY(org_id,recipient_membership_id) REFERENCES app.memberships(org_id,id)
);
ALTER TABLE app.outbox_jobs ADD COLUMN completed_at timestamptz, ADD COLUMN last_error text;
CREATE INDEX outbox_expired ON app.outbox_jobs(lease_until) WHERE state='processing';
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['notifications','notification_preferences','email_deliveries'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['issues','projects','memberships','activity_events','outbox_jobs','notifications','notification_preferences','email_deliveries'] LOOP
  EXECUTE format('CREATE POLICY worker_tenant ON app.%I TO app_worker USING(org_id=app.current_org_id()) WITH CHECK(org_id=app.current_org_id())',t);
 END LOOP;
END $$;
CREATE POLICY worker_profile ON app.users FOR SELECT TO app_worker USING(EXISTS(SELECT 1 FROM app.memberships m WHERE m.org_id=app.current_org_id() AND m.user_id=users.id AND m.state='active'));
CREATE POLICY recipient_only ON app.notifications TO app_api USING(org_id=app.current_org_id() AND EXISTS(SELECT 1 FROM app.memberships m WHERE m.id=recipient_membership_id AND m.org_id=notifications.org_id AND m.user_id=app.current_user_id() AND m.state='active'));
CREATE POLICY own_preferences ON app.notification_preferences TO app_api USING(org_id=app.current_org_id() AND EXISTS(SELECT 1 FROM app.memberships m WHERE m.id=membership_id AND m.org_id=notification_preferences.org_id AND m.user_id=app.current_user_id() AND m.state='active')) WITH CHECK(org_id=app.current_org_id() AND EXISTS(SELECT 1 FROM app.memberships m WHERE m.id=membership_id AND m.org_id=notification_preferences.org_id AND m.user_id=app.current_user_id() AND m.state='active'));
GRANT SELECT ON app.notifications TO app_api;
GRANT UPDATE(read_at) ON app.notifications TO app_api;
GRANT SELECT,INSERT,UPDATE ON app.notification_preferences TO app_api;
GRANT SELECT ON app.issues,app.projects,app.memberships,app.users,app.activity_events,app.outbox_jobs,app.notification_preferences TO app_worker;
GRANT SELECT,INSERT ON app.notifications TO app_worker;
GRANT SELECT,INSERT,UPDATE ON app.email_deliveries TO app_worker;
GRANT SELECT,UPDATE ON app.outbox_jobs TO app_scheduler;
CREATE POLICY scheduler_jobs ON app.outbox_jobs TO app_scheduler USING(true) WITH CHECK(true);
CREATE FUNCTION app.claim_job() RETURNS TABLE(id uuid,org_id uuid,lease_token uuid,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 UPDATE app.outbox_jobs j SET state='failed',last_error='attempts_exhausted',lease_token=NULL,lease_until=NULL WHERE j.attempts>=8 AND (j.state='pending' OR (j.state='processing' AND j.lease_until<now()));
 RETURN QUERY WITH candidate AS (SELECT j.id FROM app.outbox_jobs j WHERE j.attempts<8 AND ((j.state='pending' AND j.run_at<=now()) OR (j.state='processing' AND j.lease_until<now()-make_interval(secs=>LEAST(3600,power(2,j.attempts)::int*5)+mod(abs(hashtext(j.id::text)::bigint),5)::int))) ORDER BY j.run_at,j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE app.outbox_jobs j SET state='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=j.attempts+1 FROM candidate c WHERE j.id=c.id RETURNING j.id,j.org_id,j.lease_token,j.attempts;
END $$;
CREATE FUNCTION app.finish_job(job uuid,token uuid,failure text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE affected integer; BEGIN
 IF failure IS NOT NULL AND failure NOT IN ('email_budget','email_unavailable','email_rejected','email_retry','processing_failed','unsupported_job') THEN RAISE EXCEPTION 'invalid failure code'; END IF;
 UPDATE app.outbox_jobs SET state=CASE WHEN failure IS NULL THEN 'completed' WHEN attempts>=8 OR failure IN ('email_rejected','unsupported_job') THEN 'failed' ELSE 'pending' END,
 completed_at=CASE WHEN failure IS NULL THEN now() ELSE NULL END,last_error=failure,lease_token=NULL,lease_until=NULL,
 run_at=CASE WHEN failure='email_budget' THEN date_trunc('day',now())+interval '1 day 1 minute' ELSE now()+make_interval(secs=>LEAST(3600,power(2,attempts)::int*5)+floor(random()*5)::int) END
 WHERE id=job AND lease_token=token AND state='processing' AND lease_until>now();
 GET DIAGNOSTICS affected=ROW_COUNT; RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION app.claim_job(),app.finish_job(uuid,uuid,text) FROM PUBLIC;
ALTER FUNCTION app.claim_job() OWNER TO app_scheduler;
ALTER FUNCTION app.finish_job(uuid,uuid,text) OWNER TO app_scheduler;
GRANT EXECUTE ON FUNCTION app.claim_job(),app.finish_job(uuid,uuid,text) TO app_worker;
CREATE TABLE app.email_reservations (job_id uuid PRIMARY KEY,org_id uuid NOT NULL,day date NOT NULL DEFAULT CURRENT_DATE);
CREATE INDEX email_reservation_day ON app.email_reservations(day,org_id);
GRANT SELECT,INSERT ON app.email_reservations TO app_scheduler;
CREATE FUNCTION app.reserve_email(job uuid,token uuid,daily_limit integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ DECLARE tenant uuid; BEGIN
 IF daily_limit<1 OR daily_limit>10000 THEN RAISE EXCEPTION 'invalid email budget'; END IF;
 SELECT org_id INTO tenant FROM app.outbox_jobs WHERE id=job AND lease_token=token AND state='processing' AND lease_until>now();
 IF tenant IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('lira-email-budget',0));
 IF EXISTS(SELECT 1 FROM app.email_reservations WHERE job_id=job) THEN RETURN true; END IF;
 IF (SELECT count(*) FROM app.email_reservations WHERE day=CURRENT_DATE)>=daily_limit OR (SELECT count(*) FROM app.email_reservations WHERE day=CURRENT_DATE AND org_id=tenant)>=50 THEN RETURN false; END IF;
 INSERT INTO app.email_reservations(job_id,org_id) VALUES(job,tenant);RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.reserve_email(uuid,uuid,integer) FROM PUBLIC;
ALTER FUNCTION app.reserve_email(uuid,uuid,integer) OWNER TO app_scheduler;
GRANT EXECUTE ON FUNCTION app.reserve_email(uuid,uuid,integer) TO app_worker;
