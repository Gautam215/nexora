-- 0036: Durable realtime event log (PRD 25).
--
-- The realtime stream is Server-Sent Events over the existing HTTP
-- stack (no new dependency). Events are rows, not in-memory messages:
-- a client that disconnects resubscribes with its last seen version
-- and replays what it missed, and a client further behind than the
-- replay window gets an explicit resync signal instead of a flood.
-- Versions are per (organization, project), assigned under the
-- project task-graph advisory lock at publish time, so two publishers
-- can never assign the same version.
--
-- Event data is minimal (ids, titles, names) and never contains
-- secrets, bodies, or emails. Events of a purged project disappear
-- through the project foreign key's ON DELETE CASCADE; the
-- organization purge needs no extra step. The organization foreign
-- key is RESTRICT because the organization row itself is never
-- hard-deleted (it becomes a tombstone).
CREATE TABLE nexora.realtime_events (
  id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES nexora.organizations (id)
    ON DELETE RESTRICT,
  project_id uuid NOT NULL
    REFERENCES nexora.projects (id)
    ON DELETE CASCADE,
  type text NOT NULL
    CHECK (type IN ('task.created', 'task.updated', 'task.deleted', 'comment.created', 'project.updated')),
  version bigint NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (id),
  UNIQUE (organization_id, project_id, version)
);

CREATE INDEX realtime_events_project_version_idx
  ON nexora.realtime_events (organization_id, project_id, version);

ALTER TABLE nexora.realtime_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY realtime_events_select_member ON nexora.realtime_events
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY realtime_events_insert_member ON nexora.realtime_events
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_member(organization_id)
  );

-- New rate-limit scope for stream connection attempts. The CHECK
-- constraint and the function allowlist below are 0034's lists
-- verbatim plus 'realtime-connect-user'.
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
    'oauth-start',
    'oauth-callback',
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
      'oauth-start',
      'oauth-callback',
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
