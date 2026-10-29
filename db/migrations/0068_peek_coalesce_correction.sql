-- 0068_peek_coalesce_correction.sql
--
-- Correction to migration 0066 (append-only: 0066 is never edited).
-- 0066 defined count_auth_rate_limit_attempts with
-- pg_catalog.coalesce(...), which does not exist: COALESCE is a SQL
-- keyword expression, not a pg_catalog function, so every call to
-- the peek function failed with 42883. That broke the metrics
-- lockout check and the operator-auth failure alert, both of which
-- read through this function. The body below is 0066's peek
-- function verbatim except that coalesce is unqualified, which
-- resolves under the function's search_path (pg_catalog, nexora).
-- The REVOKE/GRANT lines re-assert the same privilege state.

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
    SELECT coalesce(sum(attempts)::integer, 0) INTO counted
    FROM nexora.auth_rate_limits
    WHERE scope = target_scope
      AND window_started_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => window_seconds);
  ELSE
    SELECT coalesce(attempts, 0) INTO counted
    FROM nexora.auth_rate_limits
    WHERE scope = target_scope
      AND subject_hash = target_subject_hash
      AND window_started_at > pg_catalog.clock_timestamp() - pg_catalog.make_interval(secs => window_seconds);
  END IF;

  RETURN coalesce(counted, 0);
END
$function$;

REVOKE ALL ON FUNCTION nexora.count_auth_rate_limit_attempts(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.count_auth_rate_limit_attempts(text, text, integer) TO nexora_app;
