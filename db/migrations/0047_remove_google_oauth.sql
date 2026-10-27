-- 0047: Remove Google OAuth (user decision 2026-10-26: email +
-- password only). Migration 0032 is left untouched, as history:
-- append-only means a removal is a new migration, never an edit
-- to a migration that has already run.
--
-- What this removes:
--   * The lookup function and the oauth_identities table (with
--     its RLS policies, which go away with the table).
--   * The oauth-start / oauth-callback rate-limit scopes, from
--     BOTH the auth_rate_limits CHECK and the
--     consume_auth_rate_limit allowlist. The lists below are
--     migration 0036's lists verbatim, minus those two scopes
--     (the 0038 lesson: a constraint replacement must start from
--     the CURRENT definition, not the creating migration's).
--   * Any leftover rate-limit buckets for the removed scopes, so
--     the new CHECK does not fail on existing rows.
--
-- What this deliberately does NOT change:
--   * users.password_hash stays nullable (0032 made it so for
--     OAuth-only users). Restoring NOT NULL would fail on any
--     database that already has an OAuth-only user, and it is
--     unnecessary: login by password already treats a NULL hash
--     as a failed verification, and a former OAuth-only user can
--     still recover through the password-reset flow, which sets a
--     hash. Email + password is now the only sign-in path; no
--     code reads oauth_identities anymore.
DROP FUNCTION IF EXISTS nexora.lookup_oauth_identity(text, text);
DROP TABLE IF EXISTS nexora.oauth_identities;

DELETE FROM nexora.auth_rate_limits WHERE scope IN ('oauth-start', 'oauth-callback');

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
    'realtime-connect-user'
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
      'realtime-connect-user'
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
