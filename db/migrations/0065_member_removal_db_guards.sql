-- 0065_member_removal_db_guards.sql
--
-- Member-removal guards move into the database (PRD 6, PRD 30):
-- migration 0056 enforced only active-membership plus
-- manager-or-self inside apply_organization_member_removal();
-- the two business rules that decide whether a removal is
-- legitimate at all — an owner is never removable by anyone
-- else, and a sole owner cannot leave — lived only in the
-- removal route. Any future caller that skipped the route
-- would have bypassed both. This redefinition keeps 0056's
-- behaviour for every case the route already allows, and adds
-- the two missing guards so the function alone refuses: a
-- target who is not a member, an owner target for anyone but
-- a leaving owner with another active owner, and a sole
-- owner leaving. 0056 itself is not edited. The route's
-- checks stay in place on top (defense in depth); the route
-- runs first, so its 403/404/409 responses are unchanged,
-- and this function is the backstop behind them.

CREATE OR REPLACE FUNCTION nexora.apply_organization_member_removal(
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
  target_role text;
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

  -- Business rules formerly enforced only by the removal route.
  SELECT role::text INTO target_role
  FROM nexora.organization_memberships
  WHERE organization_id = target_organization_id
    AND user_id = target_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member removal is not authorized' USING ERRCODE = '42501';
  END IF;
  IF target_role = 'owner' AND nexora.current_user_id() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'member removal is not authorized' USING ERRCODE = '42501';
  END IF;
  IF target_role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS other_owner
    WHERE other_owner.organization_id = target_organization_id
      AND other_owner.user_id <> target_user_id
      AND other_owner.role = 'owner'
      AND other_owner.status = 'active'
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
