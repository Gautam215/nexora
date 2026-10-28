-- 0056_member_removal_function.sql
--
-- Member removal (PRD 6) cannot be a plain UPDATE/DELETE through RLS:
-- there is no update-self policy on organization_memberships, so a
-- member leaving voluntarily would silently update zero rows (RLS
-- UPDATE with no matching policy is a no-op, not an error), and a
-- project viewer leaving could not unassign their own tasks either
-- (the task update policy requires manager/member work rights).
--
-- This SECURITY DEFINER function applies exactly the two privileged
-- state changes removal needs, nothing else: unassign the member's
-- tasks in the workspace, and disable the membership. The caller must
-- be an active member of the workspace and either a manager or the
-- member themselves; the removal route enforces the business rules on
-- top (owner protection, last-owner block) before calling it.
-- Preferences and pending invitations are deleted by the route through
-- their own manager/self DELETE policies, not here.

CREATE FUNCTION nexora.apply_organization_member_removal(
  target_organization_id uuid,
  target_user_id uuid
)
RETURNS TABLE (tasks_unassigned integer, membership_disabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  unassigned_count integer;
  disabled_count integer;
BEGIN
  IF nexora.current_organization_id() IS DISTINCT FROM target_organization_id THEN
    RAISE EXCEPTION 'member removal is not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS caller
    WHERE caller.organization_id = target_organization_id
      AND caller.user_id = nexora.current_user_id()
      AND caller.status = 'active'
  ) THEN
    RAISE EXCEPTION 'member removal is not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT (
    nexora.is_current_organization_manager(target_organization_id)
    OR nexora.current_user_id() = target_user_id
  ) THEN
    RAISE EXCEPTION 'member removal is not authorized' USING ERRCODE = '42501';
  END IF;

  UPDATE nexora.tasks SET assignee_user_id = NULL
  WHERE organization_id = target_organization_id
    AND assignee_user_id = target_user_id;
  GET DIAGNOSTICS unassigned_count = ROW_COUNT;

  -- No status filter here: re-removing an already-disabled member is an
  -- idempotent success, and UPDATE counts the matched row even when
  -- the value is unchanged.
  UPDATE nexora.organization_memberships SET status = 'disabled'
  WHERE organization_id = target_organization_id
    AND user_id = target_user_id;
  GET DIAGNOSTICS disabled_count = ROW_COUNT;

  RETURN QUERY SELECT unassigned_count, disabled_count > 0;
END;
$function$;

REVOKE ALL ON FUNCTION nexora.apply_organization_member_removal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.apply_organization_member_removal(uuid, uuid) TO nexora_app;
