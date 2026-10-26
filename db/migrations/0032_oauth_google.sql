-- 0032: Google OAuth identities (ARCHITECTURE.md 7.1, as implemented).
--
-- One migration carries the whole OAuth schema change, following the
-- design's RLS / security-definer split:
--   * oauth_identities stores one Google identity per user, keyed by
--     (provider, provider_subject). provider_email is informational
--     only: no unique constraint, never a lookup or linking key.
--   * Pre-auth lookup by subject goes through the SECURITY DEFINER
--     function lookup_oauth_identity(), which returns only user_id,
--     status, and email_verified_at -- never email, display_name, or
--     password_hash. RLS alone cannot serve the callback because no
--     user context exists yet.
--   * Creation and linking use withUserContext plus RLS policies
--     (user_id = current_user_id), mirroring users_insert_self and
--     friends. The app role never reads oauth_identities outside
--     these two paths.
--   * users.password_hash becomes nullable so OAuth-only users can
--     exist without a password. Login already treats a null hash as
--     a failed verification (dummy scrypt work), so a null hash can
--     never sign in by password. The length CHECK is replaced with
--     one that allows NULL.
--   * Rate-limit scopes oauth-start and oauth-callback are added to
--     BOTH the consume_auth_rate_limit allowlist and the
--     auth_rate_limits CHECK (the 0023 lesson: both must change
--     together or the first call fails with 22023 / 23514).
CREATE TABLE nexora.oauth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES nexora.users (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'google'),
  provider_subject text NOT NULL CHECK (provider_subject <> '' AND pg_catalog.length(provider_subject) <= 256),
  provider_email text NOT NULL CHECK (pg_catalog.length(provider_email) BETWEEN 3 AND 320),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_used_at timestamptz,
  CONSTRAINT oauth_identities_subject_unique UNIQUE (provider, provider_subject),
  CONSTRAINT oauth_identities_user_provider_unique UNIQUE (user_id, provider)
);

CREATE INDEX oauth_identities_user_idx ON nexora.oauth_identities (user_id);

ALTER TABLE nexora.oauth_identities ENABLE ROW LEVEL SECURITY;

CREATE POLICY oauth_identities_select_self ON nexora.oauth_identities
  FOR SELECT USING (user_id = nexora.current_user_id());
CREATE POLICY oauth_identities_insert_self ON nexora.oauth_identities
  FOR INSERT WITH CHECK (user_id = nexora.current_user_id());
CREATE POLICY oauth_identities_update_self ON nexora.oauth_identities
  FOR UPDATE USING (user_id = nexora.current_user_id())
  WITH CHECK (user_id = nexora.current_user_id());

CREATE FUNCTION nexora.lookup_oauth_identity(target_provider text, target_subject text)
RETURNS TABLE (
  user_id uuid,
  status text,
  email_verified_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT account.id,
         account.status::text,
         account.email_verified_at
  FROM nexora.oauth_identities AS identity
  JOIN nexora.users AS account ON account.id = identity.user_id
  WHERE identity.provider = target_provider
    AND identity.provider_subject = target_subject
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION nexora.lookup_oauth_identity(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.lookup_oauth_identity(text, text) TO nexora_app;

ALTER TABLE nexora.users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE nexora.users DROP CONSTRAINT users_password_hash_length;
ALTER TABLE nexora.users ADD CONSTRAINT users_password_hash_length CHECK (
  password_hash IS NULL OR pg_catalog.length(password_hash) BETWEEN 32 AND 512
);

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
    'organization-invite-user',
    'organization-invite-email',
    'organization-invitation-token',
    'project-management-user',
    'workspace-search',
    'task-file-upload',
    'oauth-start',
    'oauth-callback'
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
      'organization-invite-user',
      'organization-invite-email',
      'organization-invitation-token',
      'project-management-user',
      'workspace-search',
      'task-file-upload',
      'oauth-start',
      'oauth-callback'
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
