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
      'organization-create-user'
    )
    OR target_subject_hash !~ '^[0-9a-f]{64}$'
    OR max_attempts NOT BETWEEN 1 AND 60
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
        ELSE current_bucket.attempts + 1
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
