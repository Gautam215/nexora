-- 0062_milestone_consistency_trigger_correction.sql
--
-- Correction for 0008 (0008 itself is never edited: it has already
-- run). The production copy of guard_milestone_task_consistency()
-- diverged from the repository definition: its third EXISTS block
-- lost the milestone_dependencies join and instead joined
-- nexora.milestones to itself under the same alias ("dependent"
-- twice), so every milestone status UPDATE failed on production
-- with 42712 (table name specified more than once). The failure
-- was reproduced locally by installing the production definition
-- and running the milestone PATCH, which returned the same 500.
-- This redefinition restores the 0008 body exactly; the trigger
-- itself already exists and is not recreated.

CREATE OR REPLACE FUNCTION nexora.guard_milestone_task_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF EXISTS (
      SELECT 1
      FROM nexora.milestone_dependencies AS edge
      JOIN nexora.milestones AS prerequisite
        ON prerequisite.organization_id = edge.organization_id
       AND prerequisite.project_id = edge.project_id
       AND prerequisite.id = edge.depends_on_milestone_id
      WHERE edge.organization_id = NEW.organization_id
        AND edge.project_id = NEW.project_id
        AND edge.milestone_id = NEW.id
        AND prerequisite.status <> 'completed'
    ) THEN
      RAISE EXCEPTION 'milestone prerequisites are incomplete'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM nexora.tasks AS task
      JOIN nexora.project_task_statuses AS workflow
        ON workflow.organization_id = task.organization_id
       AND workflow.project_id = task.project_id
       AND workflow.id = task.workflow_status_id
      WHERE task.organization_id = NEW.organization_id
        AND task.project_id = NEW.project_id
        AND task.milestone_id = NEW.id
        AND task.archived_at IS NULL
        AND NOT workflow.is_done
    ) THEN
      RAISE EXCEPTION 'milestone tasks are incomplete'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'completed' AND NEW.status = 'active' AND EXISTS (
    SELECT 1
    FROM nexora.milestone_dependencies AS edge
    JOIN nexora.milestones AS dependent
      ON dependent.organization_id = edge.organization_id
     AND dependent.project_id = edge.project_id
     AND dependent.id = edge.milestone_id
    WHERE edge.organization_id = NEW.organization_id
      AND edge.project_id = NEW.project_id
      AND edge.depends_on_milestone_id = NEW.id
      AND dependent.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'completed dependent milestones must be reopened first'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;
