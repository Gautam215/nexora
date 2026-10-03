ALTER TABLE nexora.auth_rate_limits DROP CONSTRAINT auth_rate_scope;
ALTER TABLE nexora.auth_rate_limits ADD CONSTRAINT auth_rate_scope CHECK (
  scope IN (
    'register-email',
    'login-email',
    'verification-email',
    'verify-token',
    'password-reset-email',
    'password-reset-token',
    'organization-create-user',
    'organization-invite-user',
    'organization-invite-email',
    'organization-invitation-token'
  )
);

CREATE FUNCTION nexora.is_current_organization_manager(target_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS membership
      WHERE membership.organization_id = target_organization_id
        AND membership.user_id = nexora.current_user_id()
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin')
    )
$function$;

REVOKE ALL ON FUNCTION nexora.is_current_organization_manager(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.is_current_organization_manager(uuid) TO nexora_app;

CREATE POLICY memberships_select_manager ON nexora.organization_memberships
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_manager(organization_id)
  );

CREATE POLICY memberships_update_manager ON nexora.organization_memberships
  FOR UPDATE USING (
    organization_id = nexora.current_organization_id()
    AND user_id <> nexora.current_user_id()
    AND role <> 'owner'
    AND nexora.is_current_organization_manager(organization_id)
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND user_id <> nexora.current_user_id()
    AND role <> 'owner'
    AND nexora.is_current_organization_manager(organization_id)
  );

CREATE FUNCTION nexora.list_current_organization_members(target_organization_id uuid)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  role text,
  status text,
  joined_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT membership.user_id,
         account.email,
         account.display_name,
         membership.role::text,
         membership.status::text,
         membership.joined_at
  FROM nexora.organization_memberships AS membership
  JOIN nexora.users AS account ON account.id = membership.user_id
  WHERE membership.organization_id = target_organization_id
    AND target_organization_id = nexora.current_organization_id()
    AND EXISTS (
      SELECT 1
      FROM nexora.organization_memberships AS viewer
      WHERE viewer.organization_id = target_organization_id
        AND viewer.user_id = nexora.current_user_id()
        AND viewer.status = 'active'
    )
  ORDER BY membership.joined_at NULLS LAST, membership.user_id
$function$;

CREATE FUNCTION nexora.accept_organization_invitation(target_token_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  accepting_user_id uuid := nexora.current_user_id();
  invitation record;
  inserted_count integer;
BEGIN
  IF accepting_user_id IS NULL OR target_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  SELECT invite.id,
         invite.organization_id,
         invite.role,
         invite.invited_by
  INTO invitation
  FROM nexora.organization_invitations AS invite
  JOIN nexora.organizations AS organization
    ON organization.id = invite.organization_id
  JOIN nexora.users AS account
    ON account.id = accepting_user_id
   AND account.email = invite.email
  WHERE invite.token_hash = target_token_hash
    AND invite.accepted_at IS NULL
    AND invite.revoked_at IS NULL
    AND invite.expires_at > pg_catalog.clock_timestamp()
    AND organization.status = 'active'
    AND account.status = 'active'
    AND account.email_verified_at IS NOT NULL
  FOR UPDATE OF invite, organization, account;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.set_config(
    'nexora.organization_id',
    invitation.organization_id::text,
    true
  );

  INSERT INTO nexora.organization_memberships
    (organization_id, user_id, role, status, invited_by, joined_at)
  VALUES (
    invitation.organization_id,
    accepting_user_id,
    invitation.role,
    'active',
    invitation.invited_by,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (organization_id, user_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count <> 1 THEN
    RETURN false;
  END IF;

  UPDATE nexora.organization_invitations AS invite
  SET accepted_at = pg_catalog.clock_timestamp()
  WHERE invite.id = invitation.id
    AND invite.accepted_at IS NULL
    AND invite.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation changed while being accepted' USING ERRCODE = '40001';
  END IF;

  INSERT INTO nexora.audit_events
    (id, organization_id, actor_user_id, action, target_type, target_id, details)
  VALUES (
    pg_catalog.gen_random_uuid(),
    invitation.organization_id,
    accepting_user_id,
    'invitation.accepted',
    'membership',
    accepting_user_id,
    pg_catalog.jsonb_build_object(
      'role', invitation.role::text,
      'invitation_id', invitation.id::text
    )
  );

  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION nexora.list_current_organization_members(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.accept_organization_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.list_current_organization_members(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.accept_organization_invitation(text) TO nexora_app;
