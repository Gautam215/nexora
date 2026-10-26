-- 0031: give purge_expired_milestones() the tenant context its task
-- detach needs, and isolate per-milestone failures.
--
-- Two triggers fire on UPDATE OF milestone_id on nexora.tasks:
--   * tasks_graph_lock_before_write requires can_work_current_project
--     for the session's tenant context, and
--   * tasks_guard_write rejects changes in completed/archived projects.
-- The purge runs as the app role without a tenant session, so 0030's
-- detach failed every time with "project graph access denied" (42501)
-- whenever a purged milestone still had tasks. The project purge never
-- hit this because DELETE fires neither trigger.
--
-- Fix, without weakening either trigger:
--   * Per milestone, the purge adopts the deleter's tenant context
--     (deleted_by_user_id + the milestone's organization) for the
--     detach step. The deleter authorized this deletion, and the
--     detach executes its retention policy. The original context is
--     restored after the loop (unset reads back as '', the app's own
--     convention for "no context"). The function still runs as the
--     migrator under SECURITY DEFINER, so RLS behavior is unchanged.
--   * Each milestone purges in its own exception block. A milestone
--     that cannot purge (e.g. its project was archived after deletion,
--     so guard_task_write refuses the detach, or its deleter lost
--     project access) emits a WARNING and is skipped instead of
--     aborting every other milestone's purge. Skipped milestones stay
--     expired and are retried on the next run; if their project is
--     later deleted, the project purge removes them with it.
-- Signature, advisory lock, 30-day predicate, ordering, and the
-- 0030 column qualification are unchanged. CREATE OR REPLACE preserves
-- the existing EXECUTE grants.
CREATE OR REPLACE FUNCTION nexora.purge_expired_milestones()
RETURNS TABLE (milestone_id uuid, detached_task_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  expired_row record;
  detached integer;
  original_user text;
  original_org text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('nexora-milestone-purge', 0));
  original_user := pg_catalog.current_setting('nexora.user_id', true);
  original_org := pg_catalog.current_setting('nexora.organization_id', true);
  FOR expired_row IN
    SELECT id, organization_id, deleted_by_user_id FROM nexora.milestones
    WHERE deleted_at <= pg_catalog.now() - interval '30 days'
    ORDER BY deleted_at, id
  LOOP
    BEGIN
      PERFORM pg_catalog.set_config('nexora.user_id', expired_row.deleted_by_user_id::text, true);
      PERFORM pg_catalog.set_config('nexora.organization_id', expired_row.organization_id::text, true);
      DELETE FROM nexora.milestone_dependencies
      WHERE nexora.milestone_dependencies.milestone_id = expired_row.id
         OR nexora.milestone_dependencies.depends_on_milestone_id = expired_row.id;
      WITH detached_tasks AS (
        UPDATE nexora.tasks SET milestone_id = NULL
        WHERE nexora.tasks.milestone_id = expired_row.id
        RETURNING 1
      )
      SELECT count(*)::integer INTO detached FROM detached_tasks;
      DELETE FROM nexora.milestones WHERE id = expired_row.id;
      milestone_id := expired_row.id;
      detached_task_count := detached;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'nexora milestone purge skipped %: %', expired_row.id, SQLERRM;
    END;
  END LOOP;
  PERFORM pg_catalog.set_config('nexora.user_id', COALESCE(original_user, ''), true);
  PERFORM pg_catalog.set_config('nexora.organization_id', COALESCE(original_org, ''), true);
  RETURN;
END
$function$;
