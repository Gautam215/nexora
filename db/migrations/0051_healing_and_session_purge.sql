-- Healing job support (PRD 31) + stale-session cleanup.
--
-- 1. The scheduled_job_runs job CHECK gains 'healing': the healing job
--    claims one row per day like the other four jobs, so a second call
--    the same day replays instead of repeating work, and a failed run
--    can be retried the same day (see src/server/scheduled.ts).
-- 2. purge_expired_sessions() deletes sessions whose expiry has passed.
--    Expired sessions cannot authenticate (lookups require
--    expires_at > now()), so deleting them changes no live session;
--    it only stops the table growing forever. SECURITY DEFINER, like
--    the other purge functions, so the app role can run it from the
--    scheduled pool; callers outside the healing job have no reason
--    to call it, and it touches nothing but expired rows.

ALTER TABLE nexora.scheduled_job_runs DROP CONSTRAINT scheduled_job_runs_job_check;
ALTER TABLE nexora.scheduled_job_runs ADD CONSTRAINT scheduled_job_runs_job_check CHECK (
  job IN ('due-date', 'cleanup', 'email-outbox', 'alerts', 'healing')
);

CREATE FUNCTION nexora.purge_expired_sessions()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  WITH deleted AS (
    DELETE FROM nexora.user_sessions
    WHERE expires_at <= pg_catalog.now()
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer FROM deleted;
$function$;

REVOKE ALL ON FUNCTION nexora.purge_expired_sessions() FROM PUBLIC;
