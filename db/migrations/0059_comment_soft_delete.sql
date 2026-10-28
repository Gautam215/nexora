-- 0059_comment_soft_delete.sql
--
-- Comment soft-delete (PRD 27). Comments are append-only by design:
-- there is no edit path, and deleting a row would break mention
-- anchors and the comment.created event history. A deleted comment
-- is therefore hidden (deleted_at stamped) rather than removed: the
-- list query and the workspace search filter it out, while the row,
-- its mentions, and its event history stay as the audit trail.
--
-- There is deliberately no UPDATE policy on task_comments: a broad
-- policy would let any future route edit comment bodies, which the
-- append-only design forbids. The only writer is the SECURITY
-- DEFINER helper below, which sets deleted_at and nothing else,
-- and only for the comment's author or a project manager (an org
-- manager also manages every project in the org, via
-- can_manage_current_project). It returns false for an already
-- deleted or nonexistent comment so the route can answer 404.

ALTER TABLE nexora.task_comments ADD COLUMN deleted_at timestamptz;

CREATE OR REPLACE FUNCTION nexora.delete_task_comment(
  target_organization_id uuid,
  target_project_id uuid,
  target_task_id uuid,
  target_comment_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  caller_is_author boolean;
  caller_can_manage boolean;
BEGIN
  IF nexora.current_organization_id() IS DISTINCT FROM target_organization_id THEN
    RAISE EXCEPTION 'comment deletion is not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT comment.author_user_id = nexora.current_user_id()
    INTO caller_is_author
    FROM nexora.task_comments AS comment
    WHERE comment.organization_id = target_organization_id
      AND comment.project_id = target_project_id
      AND comment.task_id = target_task_id
      AND comment.id = target_comment_id
      AND comment.deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  caller_can_manage := nexora.can_manage_current_project(target_organization_id, target_project_id);
  IF NOT caller_is_author AND NOT caller_can_manage THEN
    RAISE EXCEPTION 'comment deletion is not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE nexora.task_comments
    SET deleted_at = pg_catalog.clock_timestamp()
    WHERE organization_id = target_organization_id
      AND project_id = target_project_id
      AND task_id = target_task_id
      AND id = target_comment_id
      AND deleted_at IS NULL;

  RETURN FOUND;
END
$function$;

REVOKE EXECUTE ON FUNCTION nexora.delete_task_comment(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.delete_task_comment(uuid, uuid, uuid, uuid) TO nexora_app;
