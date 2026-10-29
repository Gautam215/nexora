-- 0066_operator_db_guard_and_lockout.sql
--
-- Operator hardening, second round (PRD 30, PRD 33):
-- (1) Database-level guard for the operator aggregates. Migration
-- 0061 granted ai_operator_aggregate() and outbox_queue_depth()
-- to nexora_app, so any app-pool caller could run them and only
-- the metrics route's token stood in front. This migration
-- revokes both from nexora_app. The grant to the dedicated
-- operator role is deliberately NOT here: the role may not
-- exist yet when this migration runs, and a GRANT to a missing
-- role fails the whole migration. The operator creates the role
-- (Neon SQL Editor, as the project owner) and grants it there:
--   CREATE ROLE nexora_operator LOGIN PASSWORD '<operator password>';
--   GRANT EXECUTE ON FUNCTION nexora.ai_operator_aggregate() TO nexora_operator;
--   GRANT EXECUTE ON FUNCTION nexora.outbox_queue_depth() TO nexora_operator;
-- The metrics route then reads the aggregates through a separate
-- pool (NEXORA_OPERATOR_DATABASE_URL). Until the role, the grant,
-- and the env var are all in place, the route degrades to
-- operator: null exactly as it did before 0061 was applied, so
-- every intermediate state is safe.
-- (2) Metrics lockout scope plus a read-only counter. The
-- existing 120/hour operator-metrics limit counts every call,
-- so it cannot tell failures apart from legitimate traffic.
-- The new operator-metrics-lockout scope records failures only
-- (5 per 15 minutes per IP, checked by the metrics route before
-- the token), and count_auth_rate_limit_attempts() reads the
-- same auth_rate_limits rows back — no second counter store,
-- no duplicate control. The cron endpoint is deliberately NOT
-- locked out: a lockout there would let token spam deny
-- scheduled jobs.

ALTER TABLE nexora.auth_rate_limits DROP CONSTRAINT auth_rate_scope;
ALTER TABLE nexora.auth_rate_limits ADD CONSTRAINT auth_rate_scope CHECK (
  scope IN (
    'register-email',
    'login-email',
    'verification-email',
    'verify-token',
    'password-reset-email',
    'password-reset-token',
    'password-change',
    'organization-create-user',
    'organization-settings-user',
    'organization-deletion-user',
    'organization-invite-user',
    'organization-invite-email',
    'organization-invitation-token',
    'project-management-user',
    'workspace-search',
    'task-file-upload',
    'ai-request-user',
    'ai-request-org',
    'realtime-connect-user',
    'account-export-user',
    'account-deletion-user',
    'operator-cron',
    'operator-metrics',
    'operator-metrics-lockout'
  )
);

CREATE OR REPLACE FUNCTION nexora.consume_auth_rate_limit(
  target_scope text,
  target_subject_hash text,
  max_attempts integer,
  window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  new_attempt_count integer;
BEGIN
  IF target_scope NOT IN (
      'register-email',
      'login-email',
      'verification-email',
      'verify-token',
      'password-reset-email',
      'password-reset-token',
      'password-change',
      'organization-create-user',
      'organization-settings-user',
      'organization-deletion-user',
      'organization-invite-user',
      'organization-invite-email',
      'organization-invitation-token',
      'project-management-user',
      'workspace-search',
      'task-file-upload',
      'ai-request-user',
      'ai-request-org',
      'realtime-connect-user',
      'account-export-user',
      'account-deletion-user',
      'operator-cron',
      'operator-metrics',
      'operator-metrics-lockout'
    )
    OR target_subject_hash !~ '^[0-9a-f]{64}$'
    OR max_attempts NOT BETWEEN 1 AND 120
    OR window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO nexora.auth_rate_limits AS current_bucket
    (scope, subject_hash, window_started_at, attempts, expires_at)
  VALUES (
    target_scope,
    target_subject_hash,
    v_now,
    1,
    v_now + pg_catalog.make_interval(secs => window_seconds)
  )
  ON CONFLICT (scope, subject_hash) DO UPDATE
  SET attempts = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN 1
        ELSE LEAST(current_bucket.attempts + 1, 1000)
      END,
      window_started_at = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN v_now
        ELSE current_bucket.window_started_at
      END,
      expires_at = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN v_now + pg_catalog.make_interval(secs => window_seconds)
        ELSE current_bucket.expires_at
      END
  RETURNING attempts INTO new_attempt_count;

  RETURN new_attempt_count <= max_attempts;
END
$function$;

-- Read-only counter over the same rows consume writes. A NULL
-- subject sums the whole scope (used for the operator-auth
-- failure alert); a subject hash counts one IP's bucket. Rows
-- whose window has expired count as zero, so a lockout expires
-- on its own without any cleanup job.
CREATE OR REPLACE FUNCTION nexora.count_auth_rate_limit_attempts(
  target_scope text,
  target_subject_hash text,
  window_seconds integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  counted integer;
BEGIN
  IF target_scope NOT IN (
      'register-email',
      'login-email',
      'verification-email',
      'verify-token',
      'password-reset-email',
      'password-reset-token',
      'password-change',
      'organization-create-user',
      'organization-settings-user',
      'organization-deletion-user',
      'organization-invite-user',
      'organization-invite-email',
      'organization-invitation-token',
      'project-management-user',
      'workspace-search',
      'task-file-upload',
      'ai-request-user',
      'ai-request-org',
      'realtime-connect-user',
      'account-export-user',
      'account-deletion-user',
      'operator-cron',
      'operator-metrics',
      'operator-metrics-lockout'
    )
    OR window_seconds NOT BETWEEN 60 AND 86400
    OR (target_subject_hash IS NOT NULL AND target_subject_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = '22023';
  END IF;

  IF target_subject_hash IS NULL THEN
    SELECT pg_catalog.coalesce(pg_catalog.sum(attempts)::integer, 0) INTO counted
    FROM nexora.auth_rate_limits
    WHERE scope = target_scope
      AND window_started_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => window_seconds);
  ELSE
    SELECT pg_catalog.coalesce(attempts, 0) INTO counted
    FROM nexora.auth_rate_limits
    WHERE scope = target_scope
      AND subject_hash = target_subject_hash
      AND window_started_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => window_seconds);
  END IF;

  RETURN pg_catalog.coalesce(counted, 0);
END
$function$;

REVOKE ALL ON FUNCTION nexora.count_auth_rate_limit_attempts(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.count_auth_rate_limit_attempts(text, text, integer) TO nexora_app;

REVOKE EXECUTE ON FUNCTION nexora.ai_operator_aggregate() FROM nexora_app;
REVOKE EXECUTE ON FUNCTION nexora.outbox_queue_depth() FROM nexora_app;
