-- 0067_totp_credentials.sql
--
-- Authenticator second factor for destructive actions (PRD 30):
-- account deletion and workspace deletion already require the
-- current password; when the caller has enrolled an authenticator
-- app (Google or Microsoft Authenticator), they must additionally
-- present the current 6-digit TOTP code. The secret itself is
-- never stored in plaintext: the app layer encrypts it with
-- AES-256-GCM under NEXORA_TOTP_ENCRYPTION_KEY and only the
-- ciphertext, nonce, and tag live here. A row with verified_at
-- NULL is a pending enrollment (setup shown, code not yet
-- proven); only a verified row gates deletion, so an abandoned
-- setup can never lock the owner out of deleting. No QR image
-- is generated server-side (that would need a new dependency);
-- enrollment shows the manual setup key plus the otpauth:// URL,
-- which both authenticator apps accept. Column grants for this
-- table live in db/runtime-grants.sql, applied by the migrator
-- in the same run; the TOTP verify rate-limit scope below bounds
-- enrollment verification (deletion-time codes are already
-- bounded by the account/workspace deletion rate limits, so no
-- second scope is created for them).

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
    'operator-metrics-lockout',
    'totp-verify-user'
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
      'operator-metrics-lockout',
      'totp-verify-user'
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

CREATE TABLE nexora.user_totp_credentials (
  user_id uuid PRIMARY KEY REFERENCES nexora.users(id) ON DELETE CASCADE,
  secret_ciphertext text NOT NULL,
  secret_nonce text NOT NULL,
  secret_tag text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE nexora.user_totp_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_totp_credentials_select_self ON nexora.user_totp_credentials
  FOR SELECT USING (user_id = nexora.current_user_id());

CREATE POLICY user_totp_credentials_insert_self ON nexora.user_totp_credentials
  FOR INSERT WITH CHECK (user_id = nexora.current_user_id());

CREATE POLICY user_totp_credentials_update_self ON nexora.user_totp_credentials
  FOR UPDATE USING (user_id = nexora.current_user_id())
  WITH CHECK (user_id = nexora.current_user_id());

CREATE POLICY user_totp_credentials_delete_self ON nexora.user_totp_credentials
  FOR DELETE USING (user_id = nexora.current_user_id());
