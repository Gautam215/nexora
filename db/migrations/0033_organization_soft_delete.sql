-- 0033: Organization soft delete and retention purge.
--
-- Organizations gain deleted_at / deleted_by_user_id (both NULL means
-- active), mirroring the project and milestone soft-delete columns, plus
-- purged_at, which the purge sets once its children are gone. The status
-- moves to 'deletion_pending' on delete: the enum value already existed
-- but was never used. Existing reads already filter organization.status =
-- 'active' (organization list, organization detail, organization update),
-- and withOrganizationContext additionally rejects non-active
-- organizations, so a soft-deleted organization is immediately invisible
-- across every organization-scoped route.
--
-- Audit retention decision (IMPLEMENTATION_PLAN.md Phase 3 item 3):
-- audit events are retained indefinitely, exactly as for project
-- deletion. audit_events.organization_id is ON DELETE RESTRICT, so the
-- organization row itself is NEVER hard-deleted: the purge removes every
-- operational child row and leaves the organization tombstone (id, slug,
-- deleted_at, deleted_by_user_id, purged_at) plus its audit trail. The
-- tombstone also keeps the slug reserved, so a deleted workspace's
-- address cannot be re-registered by someone else.
--
-- Purge order (foreign-key order; per-organization loop with failure
-- isolation, mirroring purge_expired_milestones): task files (storage
-- keys returned for post-commit disk removal), comment mentions,
-- comments, task dependencies, tasks, milestone dependencies,
-- milestones, task statuses, mutation idempotency, project memberships,
-- projects, invitations, notification preferences, organization
-- memberships, then the tombstone is marked purged. Notifications need
-- no explicit step: they reference projects through the composite
-- (organization_id, project_id) foreign key, which migration 0027 made
-- ON DELETE CASCADE, and their FORCE row-level security would make an
-- explicit session-less DELETE a no-op anyway (see DATABASE.md).
-- Graph locks also cascade from projects. Users, sessions, and OAuth
-- identities are never touched: they are user-scoped, not
-- organization-scoped.
ALTER TABLE nexora.organizations
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid,
  ADD COLUMN purged_at timestamptz,
  ADD CONSTRAINT organizations_deleter_fk
    FOREIGN KEY (deleted_by_user_id)
    REFERENCES nexora.users (id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT organizations_deleted_by_consistent CHECK (
    (deleted_at IS NULL) = (deleted_by_user_id IS NULL)
  ),
  ADD CONSTRAINT organizations_purged_after_delete CHECK (
    purged_at IS NULL OR deleted_at IS NOT NULL
  );

-- The deleter references users, not organization_memberships, on purpose:
-- the purge deletes memberships, so a membership foreign key would block
-- the purge itself. Users are never deleted by an organization purge.
CREATE INDEX organizations_active_list_idx
  ON nexora.organizations (created_at DESC, id DESC)
  WHERE status = 'active' AND deleted_at IS NULL;
CREATE INDEX organizations_retention_idx
  ON nexora.organizations (deleted_at)
  WHERE status = 'deletion_pending' AND purged_at IS NULL;

CREATE FUNCTION nexora.purge_expired_organizations()
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

CREATE FUNCTION nexora.list_expired_organizations()
RETURNS TABLE(organization_id uuid, organization_name text, project_count bigint, file_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT organization.id,
         organization.name,
         (SELECT pg_catalog.count(*) FROM nexora.projects AS project
           WHERE project.organization_id = organization.id),
         (SELECT pg_catalog.count(*) FROM nexora.task_files AS file
           WHERE file.organization_id = organization.id)
  FROM nexora.organizations AS organization
  WHERE organization.status = 'deletion_pending'
    AND organization.purged_at IS NULL
    AND organization.deleted_at <= pg_catalog.now() - interval '30 days'
$function$;

REVOKE ALL ON FUNCTION nexora.purge_expired_organizations() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.list_expired_organizations() FROM PUBLIC;

-- Rate-limit scope for organization deletion, following the 0023
-- template used by 0028 and 0032: both the function allowlist and the
-- table CHECK must accept the new scope. The function body below is
-- 0032's body verbatim, with only 'organization-deletion-user' added
-- to the allowlist; nothing else about the bucket logic changes.
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
      'organization-deletion-user',
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
