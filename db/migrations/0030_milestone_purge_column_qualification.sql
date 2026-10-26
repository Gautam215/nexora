-- 0030: qualify milestone column references in purge_expired_milestones().
--
-- 0029 declared the function with RETURNS TABLE (milestone_id, ...),
-- which makes milestone_id an OUT parameter. Inside PL/pgSQL, the
-- unqualified references in the dependency DELETE and the task UPDATE
-- then became ambiguous ("column reference milestone_id is ambiguous",
-- error 42702) and the purge failed on its first statement. The listing
-- function is unaffected: it is a plain SQL function and its dry-run
-- output was verified working before this fix.
--
-- This migration only replaces the function body with table-qualified
-- column references. The signature, advisory lock, 30-day predicate,
-- per-milestone order (dependencies, task detachment, milestone row),
-- and SECURITY DEFINER / search_path settings are unchanged from 0029.
-- CREATE OR REPLACE preserves the existing EXECUTE grants.
CREATE OR REPLACE FUNCTION nexora.purge_expired_milestones()
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
    WHERE nexora.milestone_dependencies.milestone_id = expired_id
       OR nexora.milestone_dependencies.depends_on_milestone_id = expired_id;
    WITH detached_tasks AS (
      UPDATE nexora.tasks SET milestone_id = NULL
      WHERE nexora.tasks.milestone_id = expired_id
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
