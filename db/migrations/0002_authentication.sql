CREATE TABLE nexora.email_verification_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nexora.users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT email_verification_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_verification_expiry_after_create CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX email_verification_one_live_token_per_user
  ON nexora.email_verification_tokens (user_id)
  WHERE consumed_at IS NULL;
CREATE INDEX email_verification_expiry
  ON nexora.email_verification_tokens (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE nexora.password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nexora.users(id) ON DELETE RESTRICT,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT password_reset_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_expiry_after_create CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX password_reset_one_live_token_per_user
  ON nexora.password_reset_tokens (user_id)
  WHERE consumed_at IS NULL;
CREATE INDEX password_reset_expiry
  ON nexora.password_reset_tokens (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE nexora.auth_rate_limits (
  scope text NOT NULL,
  subject_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, subject_hash),
  CONSTRAINT auth_rate_scope CHECK (
    scope IN (
      'register-email',
      'login-email',
      'verification-email',
      'verify-token',
      'password-reset-email',
      'password-reset-token',
      'organization-create-user'
    )
  ),
  CONSTRAINT auth_rate_subject_hash_format CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_rate_attempts_positive CHECK (attempts BETWEEN 1 AND 1000),
  CONSTRAINT auth_rate_expiry_after_start CHECK (expires_at > window_started_at)
);

CREATE INDEX auth_rate_limits_expiry ON nexora.auth_rate_limits (expires_at);

ALTER TABLE nexora.email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.auth_rate_limits ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION nexora.lookup_user_for_login(target_email text)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  password_hash text,
  status text,
  email_verified_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT account.id,
         account.email,
         account.display_name,
         account.password_hash,
         account.status::text,
         account.email_verified_at
  FROM nexora.users AS account
  WHERE account.email = pg_catalog.lower(pg_catalog.btrim(target_email))
  LIMIT 1
$function$;

CREATE FUNCTION nexora.lookup_active_session(target_token_hash text)
RETURNS TABLE (
  session_id uuid,
  user_id uuid,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT session.id, session.user_id, session.expires_at
  FROM nexora.user_sessions AS session
  JOIN nexora.users AS account ON account.id = session.user_id
  WHERE session.token_hash = target_token_hash
    AND session.revoked_at IS NULL
    AND session.expires_at > pg_catalog.now()
    AND account.status = 'active'
    AND account.email_verified_at IS NOT NULL
  LIMIT 1
$function$;

CREATE FUNCTION nexora.issue_email_verification(
  target_email text,
  token_id uuid,
  token_hash text,
  valid_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  target_user_id uuid;
  issued_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF token_hash !~ '^[0-9a-f]{64}$'
    OR valid_until <= issued_at
    OR valid_until > issued_at + interval '24 hours' THEN
    RAISE EXCEPTION 'invalid verification token metadata' USING ERRCODE = '22023';
  END IF;

  SELECT account.id
  INTO target_user_id
  FROM nexora.users AS account
  WHERE account.email = pg_catalog.lower(pg_catalog.btrim(target_email))
    AND account.status = 'active'
    AND account.email_verified_at IS NULL
  FOR UPDATE;

  IF target_user_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE nexora.email_verification_tokens AS token
  SET consumed_at = issued_at
  WHERE token.user_id = target_user_id
    AND token.consumed_at IS NULL;

  INSERT INTO nexora.email_verification_tokens (id, user_id, token_hash, expires_at)
  VALUES (token_id, target_user_id, token_hash, valid_until);

  RETURN true;
END
$function$;

CREATE FUNCTION nexora.consume_email_verification(target_token_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  target_user_id uuid;
BEGIN
  IF target_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  SELECT token.user_id
  INTO target_user_id
  FROM nexora.email_verification_tokens AS token
  JOIN nexora.users AS account ON account.id = token.user_id
  WHERE token.token_hash = target_token_hash
    AND token.consumed_at IS NULL
    AND token.expires_at > pg_catalog.clock_timestamp()
    AND account.status = 'active'
  FOR UPDATE OF token, account;

  IF target_user_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE nexora.email_verification_tokens AS token
  SET consumed_at = pg_catalog.clock_timestamp()
  WHERE token.token_hash = target_token_hash
    AND token.consumed_at IS NULL;

  UPDATE nexora.users AS account
  SET email_verified_at = COALESCE(account.email_verified_at, pg_catalog.clock_timestamp())
  WHERE account.id = target_user_id
    AND account.status = 'active';

  RETURN FOUND;
END
$function$;

CREATE FUNCTION nexora.issue_password_reset(
  target_email text,
  token_id uuid,
  token_hash text,
  valid_until timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  target_user_id uuid;
  issued_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF token_hash !~ '^[0-9a-f]{64}$'
    OR valid_until <= issued_at
    OR valid_until > issued_at + interval '2 hours' THEN
    RAISE EXCEPTION 'invalid password reset token metadata' USING ERRCODE = '22023';
  END IF;

  SELECT account.id
  INTO target_user_id
  FROM nexora.users AS account
  WHERE account.email = pg_catalog.lower(pg_catalog.btrim(target_email))
    AND account.status = 'active'
    AND account.email_verified_at IS NOT NULL
  FOR UPDATE;

  IF target_user_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE nexora.password_reset_tokens AS token
  SET consumed_at = issued_at
  WHERE token.user_id = target_user_id
    AND token.consumed_at IS NULL;

  INSERT INTO nexora.password_reset_tokens (id, user_id, token_hash, expires_at)
  VALUES (token_id, target_user_id, token_hash, valid_until);

  RETURN true;
END
$function$;

CREATE FUNCTION nexora.consume_password_reset(
  target_token_hash text,
  replacement_password_hash text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  target_user_id uuid;
BEGIN
  IF target_token_hash !~ '^[0-9a-f]{64}$'
    OR pg_catalog.length(replacement_password_hash) NOT BETWEEN 32 AND 512 THEN
    RETURN false;
  END IF;

  SELECT token.user_id
  INTO target_user_id
  FROM nexora.password_reset_tokens AS token
  JOIN nexora.users AS account ON account.id = token.user_id
  WHERE token.token_hash = target_token_hash
    AND token.consumed_at IS NULL
    AND token.expires_at > pg_catalog.clock_timestamp()
    AND account.status = 'active'
    AND account.email_verified_at IS NOT NULL
  FOR UPDATE OF token, account;

  IF target_user_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE nexora.password_reset_tokens AS token
  SET consumed_at = pg_catalog.clock_timestamp()
  WHERE token.token_hash = target_token_hash
    AND token.consumed_at IS NULL;

  UPDATE nexora.users AS account
  SET password_hash = replacement_password_hash
  WHERE account.id = target_user_id
    AND account.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'password reset account changed during update' USING ERRCODE = '40001';
  END IF;

  UPDATE nexora.user_sessions AS session
  SET revoked_at = pg_catalog.clock_timestamp()
  WHERE session.user_id = target_user_id
    AND session.revoked_at IS NULL;

  RETURN true;
END
$function$;

CREATE FUNCTION nexora.consume_auth_rate_limit(
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
  current_time timestamptz := pg_catalog.clock_timestamp();
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
    current_time,
    1,
    current_time + pg_catalog.make_interval(secs => window_seconds)
  )
  ON CONFLICT (scope, subject_hash) DO UPDATE
  SET attempts = CASE
        WHEN current_bucket.window_started_at
          <= current_time - pg_catalog.make_interval(secs => window_seconds)
          THEN 1
        ELSE current_bucket.attempts + 1
      END,
      window_started_at = CASE
        WHEN current_bucket.window_started_at
          <= current_time - pg_catalog.make_interval(secs => window_seconds)
          THEN current_time
        ELSE current_bucket.window_started_at
      END,
      expires_at = CASE
        WHEN current_bucket.window_started_at
          <= current_time - pg_catalog.make_interval(secs => window_seconds)
          THEN current_time + pg_catalog.make_interval(secs => window_seconds)
        ELSE current_bucket.expires_at
      END
  RETURNING attempts INTO new_attempt_count;

  RETURN new_attempt_count <= max_attempts;
END
$function$;

REVOKE ALL ON FUNCTION nexora.lookup_user_for_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.lookup_active_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.issue_email_verification(text, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.consume_email_verification(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.issue_password_reset(text, uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.consume_password_reset(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.consume_auth_rate_limit(text, text, integer, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION nexora.lookup_user_for_login(text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.lookup_active_session(text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.issue_email_verification(text, uuid, text, timestamptz) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.consume_email_verification(text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.issue_password_reset(text, uuid, text, timestamptz) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.consume_password_reset(text, text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.consume_auth_rate_limit(text, text, integer, integer) TO nexora_app;
