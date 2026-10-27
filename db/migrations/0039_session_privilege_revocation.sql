-- Session rotation on privilege change (approved default, 2026-10-26).
-- No periodic rotation: a session token alone never grants a role —
-- every request re-checks membership through RLS/tenant context, so a
-- role downgrade takes effect immediately even without revocation.
-- Revocation is defense-in-depth for privilege changes, and it is the
-- enforcement mechanism when a member is disabled: a disabled member
-- must not keep a usable session. Password change already revokes all
-- other sessions and keeps the current, provably-trusted session;
-- password reset (unauthenticated) revokes all sessions.
--
-- These functions are SECURITY DEFINER because the session table's
-- RLS policies only allow a user to update their own sessions, while
-- privilege changes are made by an administrator/manager about
-- another user. Authorization is therefore checked inside each
-- function, and the functions refuse owner targets: an organization
-- owner and a project owner cannot have their sessions revoked
-- through a membership change made by someone else.

CREATE FUNCTION nexora.revoke_user_sessions_for_org_privilege_change(
  target_organization_id uuid,
  target_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  revoked_count integer;
BEGIN
  IF nexora.current_user_id() IS NULL
    OR nexora.current_organization_id() IS DISTINCT FROM target_organization_id THEN
    RAISE EXCEPTION 'session revocation is not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.user_id = nexora.current_user_id()
      AND membership.role IN ('owner', 'admin')
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'session revocation is not authorized' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.user_id = target_user_id
      AND membership.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'organization owner sessions cannot be revoked here' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.user_id = target_user_id
  ) THEN
    RAISE EXCEPTION 'session revocation target is not a member' USING ERRCODE = '42501';
  END IF;
  UPDATE nexora.user_sessions
  SET revoked_at = pg_catalog.now()
  WHERE user_id = target_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  RETURN revoked_count;
END;
$function$;

REVOKE ALL ON FUNCTION nexora.revoke_user_sessions_for_org_privilege_change(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.revoke_user_sessions_for_org_privilege_change(uuid, uuid) TO nexora_app;

CREATE FUNCTION nexora.revoke_user_sessions_for_project_privilege_change(
  target_organization_id uuid,
  target_project_id uuid,
  target_user_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  revoked_count integer;
BEGIN
  IF nexora.current_user_id() IS NULL
    OR nexora.current_organization_id() IS DISTINCT FROM target_organization_id THEN
    RAISE EXCEPTION 'session revocation is not authorized' USING ERRCODE = '42501';
  END IF;
  IF NOT nexora.can_manage_current_project(target_organization_id, target_project_id) THEN
    RAISE EXCEPTION 'session revocation is not authorized' USING ERRCODE = '42501';
  END IF;
  IF nexora.is_project_owner(target_organization_id, target_project_id, target_user_id) THEN
    RAISE EXCEPTION 'project owner sessions cannot be revoked here' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.project_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.project_id = target_project_id
      AND membership.user_id = target_user_id
  ) THEN
    RAISE EXCEPTION 'session revocation target is not a project member' USING ERRCODE = '42501';
  END IF;
  UPDATE nexora.user_sessions
  SET revoked_at = pg_catalog.now()
  WHERE user_id = target_user_id AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  RETURN revoked_count;
END;
$function$;

REVOKE ALL ON FUNCTION nexora.revoke_user_sessions_for_project_privilege_change(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.revoke_user_sessions_for_project_privilege_change(uuid, uuid, uuid) TO nexora_app;
