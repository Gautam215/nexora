-- 0034: AI execution records, AI rate-limit scopes, and AI rows in the
-- organization purge.
--
-- ai_executions is metadata only, never content: it records WHO ran
-- WHICH workflow against WHICH project, with WHICH provider/model,
-- and the outcome (token counts, latency, error code). Prompts and
-- provider responses are NEVER stored here. They contain tenant data,
-- and storing them would widen exposure for no operational benefit;
-- the provider call itself is transient. This follows PRD 23 ("log
-- safe AI execution metadata", "redact secrets", "do not expose
-- internal prompts or credentials").
--
-- Tenancy: rows are organization-scoped and user-scoped. RLS policies
-- require the current organization context and the current user, so a
-- user can only ever read or complete their own executions, and only
-- while an active member of the organization. The application writes
-- executions in two short transactions (start, then complete/fail)
-- around the provider call, never in one transaction spanning the
-- provider call: holding a pooled connection open during a provider
-- round-trip would exhaust the pool under load.
--
-- Retention: executions are operational records, not audit events.
-- The organization purge deletes them (step added to
-- purge_expired_organizations() below, which is 0033's body verbatim
-- plus that one DELETE). Project-scoped rows also disappear when
-- their project is purged, via ON DELETE CASCADE. audit_events is
-- untouched by this migration and remains the permanent trail.
--
-- Rate limits (following the 0023 template used by 0028, 0032, 0033):
-- 'ai-request-user' (per user) and 'ai-request-org' (per organization)
-- are added to BOTH the table CHECK and the function allowlist. The
-- function body below is 0033's body verbatim, with only those two
-- scopes added. Note the function caps max_attempts at 120, so the
-- organization limit is 120/hour, not higher.
CREATE TABLE nexora.ai_executions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES nexora.organizations (id)
    ON DELETE RESTRICT,
  project_id uuid
    REFERENCES nexora.projects (id)
    ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES nexora.users (id)
    ON DELETE RESTRICT,
  workflow text NOT NULL
    CHECK (workflow IN ('planning', 'extraction', 'summarization', 'risk', 'assistant')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL
    CHECK (status IN ('started', 'succeeded', 'failed')),
  prompt_tokens integer CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens integer CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text
    CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,40}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  completed_at timestamptz,
  CONSTRAINT ai_executions_completed_consistent CHECK (
    (status = 'started' AND completed_at IS NULL)
    OR (status <> 'started' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX ai_executions_org_user_idx
  ON nexora.ai_executions (organization_id, user_id, created_at DESC, id DESC);
CREATE INDEX ai_executions_org_created_idx
  ON nexora.ai_executions (organization_id, created_at DESC, id DESC);

ALTER TABLE nexora.ai_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_executions_select_own ON nexora.ai_executions
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY ai_executions_insert_own ON nexora.ai_executions
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY ai_executions_update_own ON nexora.ai_executions
  FOR UPDATE USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

-- Organization purge, extended: 0033's function verbatim plus the
-- ai_executions DELETE after projects (project-scoped rows are
-- already gone via CASCADE by then; this removes org-level rows
-- with a NULL project, e.g. planning drafts).
CREATE OR REPLACE FUNCTION nexora.purge_expired_organizations()
RETURNS TABLE(organization_id uuid, storage_key uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  expired_org RECORD;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora-organization-purge', 0));
  FOR expired_org IN
    SELECT organization.id
    FROM nexora.organizations AS organization
    WHERE organization.status = 'deletion_pending'
      AND organization.purged_at IS NULL
      AND organization.deleted_at <= pg_catalog.now() - interval '30 days'
  LOOP
    BEGIN
      RETURN QUERY
      DELETE FROM nexora.task_files AS file
      WHERE file.organization_id = expired_org.id
      RETURNING expired_org.id, file.storage_key;
      DELETE FROM nexora.task_comment_mentions AS mention
      WHERE mention.organization_id = expired_org.id;
      DELETE FROM nexora.task_comments AS comment
      WHERE comment.organization_id = expired_org.id;
      DELETE FROM nexora.task_dependencies AS dependency
      WHERE dependency.organization_id = expired_org.id;
      DELETE FROM nexora.tasks AS task
      WHERE task.organization_id = expired_org.id;
      DELETE FROM nexora.milestone_dependencies AS dependency
      WHERE dependency.organization_id = expired_org.id;
      DELETE FROM nexora.milestones AS milestone
      WHERE milestone.organization_id = expired_org.id;
      DELETE FROM nexora.project_task_statuses AS status
      WHERE status.organization_id = expired_org.id;
      DELETE FROM nexora.project_mutation_idempotency AS idempotency
      WHERE idempotency.organization_id = expired_org.id;
      DELETE FROM nexora.project_memberships AS membership
      WHERE membership.organization_id = expired_org.id;
      DELETE FROM nexora.projects AS project
      WHERE project.organization_id = expired_org.id;
      DELETE FROM nexora.ai_executions AS execution
      WHERE execution.organization_id = expired_org.id;
      DELETE FROM nexora.organization_invitations AS invitation
      WHERE invitation.organization_id = expired_org.id;
      DELETE FROM nexora.notification_preferences AS preference
      WHERE preference.organization_id = expired_org.id;
      DELETE FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = expired_org.id;
      UPDATE nexora.organizations AS organization
      SET purged_at = pg_catalog.now()
      WHERE organization.id = expired_org.id;
      -- One marker row per purged organization, even when it has no
      -- files: callers count purged organizations from these rows and
      -- must skip the NULL storage key when removing files from disk.
      RETURN QUERY SELECT expired_org.id, NULL::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'nexora organization purge skipped %: %', expired_org.id, SQLERRM;
    END;
  END LOOP;
  RETURN;
END
$function$;

REVOKE ALL ON FUNCTION nexora.purge_expired_organizations() FROM PUBLIC;

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
    'ai-request-org'
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
      'ai-request-org'
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
