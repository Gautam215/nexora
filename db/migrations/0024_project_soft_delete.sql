-- 0024: Project soft delete and retention purge.
--
-- Projects gain deleted_at / deleted_by_user_id (both NULL means active),
-- mirroring the task_files soft-delete columns, foreign key, and paired-NULL
-- check. A soft-deleted project is hidden by the application filtering on
-- deleted_at IS NULL in its queries. The RLS gate functions
-- (can_manage_current_project, can_access_current_project,
-- can_work_current_project) and all RLS policies are intentionally
-- unchanged: adding a deleted filter to the projects UPDATE policy's
-- WITH CHECK would reject the soft-delete UPDATE itself, because the new
-- row would no longer satisfy the check.
ALTER TABLE nexora.projects
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid,
  ADD CONSTRAINT projects_deleter_fk
    FOREIGN KEY (organization_id, deleted_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT projects_deleted_by_consistent CHECK (
    (deleted_at IS NULL) = (deleted_by_user_id IS NULL)
  );

CREATE INDEX projects_active_list_idx
  ON nexora.projects (organization_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX projects_retention_idx
  ON nexora.projects (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Purge projects soft-deleted at least 30 days ago, in foreign-key order.
-- Returns the storage keys of purged task files so the cleanup command can
-- remove them from disk after the database purge commits. Audit events are
-- never deleted: they carry no project foreign key and are retained
-- indefinitely. The transaction-scoped advisory lock serializes concurrent
-- purges so two cleanup runs cannot return (and remove) the same file keys.
-- The function runs SECURITY DEFINER as the migration owner, mirroring
-- purge_expired_task_files(); the application role needs only the EXECUTE
-- grant (see db/runtime-grants.sql), never direct DELETE privileges.
CREATE FUNCTION nexora.purge_expired_projects()
RETURNS TABLE(storage_key uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora-project-purge', 0));
  RETURN QUERY
  DELETE FROM nexora.task_files AS file
  WHERE file.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  )
  RETURNING file.storage_key;
  DELETE FROM nexora.task_comment_mentions AS mention
  WHERE mention.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.task_comments AS comment
  WHERE comment.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.task_dependencies AS dependency
  WHERE dependency.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.tasks AS task
  WHERE task.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.milestone_dependencies AS dependency
  WHERE dependency.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.milestones AS milestone
  WHERE milestone.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.project_task_statuses AS status
  WHERE status.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.project_mutation_idempotency AS idempotency
  WHERE idempotency.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.notifications AS notification
  WHERE notification.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.project_memberships AS membership
  WHERE membership.project_id IN (
    SELECT project.id FROM nexora.projects AS project
    WHERE project.deleted_at <= pg_catalog.now() - interval '30 days'
  );
  DELETE FROM nexora.projects AS project
  WHERE project.deleted_at <= pg_catalog.now() - interval '30 days';
  RETURN;
END
$function$;

REVOKE ALL ON FUNCTION nexora.purge_expired_projects() FROM PUBLIC;
