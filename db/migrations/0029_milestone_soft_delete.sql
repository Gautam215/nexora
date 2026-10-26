-- Milestone soft delete, mirroring the project soft delete in 0024.
-- A deleted milestone is immediately invisible (every milestone read
-- filters on deleted_at IS NULL) and is permanently purged only after
-- 30 days. Tasks are NOT deleted with their milestone: tasks belong
-- to the project, so the purge detaches them (milestone_id NULL)
-- instead. Milestone dependency rows in either direction are deleted
-- by the purge, because both of their foreign keys are RESTRICT.
-- Audit events are never touched: audit_events has no milestone
-- foreign key, so milestone.created/updated/deleted records survive
-- the purge indefinitely, exactly like project audit records.
ALTER TABLE nexora.milestones
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_user_id uuid,
  ADD CONSTRAINT milestones_deleted_by_consistent CHECK (
    (deleted_at IS NULL) = (deleted_by_user_id IS NULL)
  ),
  ADD CONSTRAINT milestones_deleter_fk
    FOREIGN KEY (organization_id, deleted_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT;

CREATE INDEX milestones_active_list_idx
  ON nexora.milestones (organization_id, project_id, start_date NULLS LAST, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX milestones_retention_idx
  ON nexora.milestones (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- Purge expired soft-deleted milestones. Runs as SECURITY DEFINER
-- because the cleanup command runs as the runtime role without a
-- tenant session, so plain statements under RLS would see nothing.
-- Dependencies go first (both RESTRICT foreign keys), then task
-- detachment (also RESTRICT), then the milestone rows themselves.
-- One milestone at a time, in dependency-safe order, so a failure
-- aborts the whole purge loudly instead of half-purging.
CREATE FUNCTION nexora.purge_expired_milestones()
RETURNS TABLE (milestone_id uuid, detached_task_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  expired_id uuid;
  detached integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora-milestone-purge', 0));
  FOR expired_id IN
    SELECT id FROM nexora.milestones
    WHERE deleted_at <= pg_catalog.now() - interval '30 days'
    ORDER BY deleted_at, id
  LOOP
    DELETE FROM nexora.milestone_dependencies
    WHERE milestone_id = expired_id OR depends_on_milestone_id = expired_id;
    WITH detached_tasks AS (
      UPDATE nexora.tasks SET milestone_id = NULL
      WHERE milestone_id = expired_id
      RETURNING 1
    )
    SELECT count(*)::integer INTO detached FROM detached_tasks;
    DELETE FROM nexora.milestones WHERE id = expired_id;
    milestone_id := expired_id;
    detached_task_count := detached;
    RETURN NEXT;
  END LOOP;
  RETURN;
END
$function$;
REVOKE ALL ON FUNCTION nexora.purge_expired_milestones() FROM PUBLIC;

-- Read-only listing for the cleanup command's --dry-run mode and
-- purge counts. Same SECURITY DEFINER rationale as the purge: the
-- runtime role has no tenant session, so it cannot list expired
-- milestones through RLS.
CREATE FUNCTION nexora.list_expired_milestones()
RETURNS TABLE (milestone_id uuid, milestone_name text, task_count integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT milestone.id, milestone.name, count(task.id)::integer
  FROM nexora.milestones AS milestone
  LEFT JOIN nexora.tasks AS task
    ON task.organization_id = milestone.organization_id
   AND task.project_id = milestone.project_id
   AND task.milestone_id = milestone.id
  WHERE milestone.deleted_at <= pg_catalog.now() - interval '30 days'
  GROUP BY milestone.id, milestone.name
  ORDER BY milestone.deleted_at, milestone.id;
$function$;
REVOKE ALL ON FUNCTION nexora.list_expired_milestones() FROM PUBLIC;
