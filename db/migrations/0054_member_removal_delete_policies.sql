-- 0054_member_removal_delete_policies.sql
--
-- Member removal (PRD 6) needs DELETE on four tables that previously had
-- no DELETE policy and no DELETE grant at all: organization memberships,
-- project memberships, notification preferences, and organization
-- invitations (pending invitations for a removed member must die, or the
-- removed member could rejoin by accepting an old token).
--
-- The policies mirror the existing manager/self split. Managers delete
-- non-owner rows that are not their own; anyone deletes their own row
-- (self-leave). The route enforces the business rules on top of this:
-- owners cannot be removed by anyone else, and a sole owner cannot
-- leave. RLS here enforces tenant isolation only, not business rules.
-- The matching DELETE grants live in db/runtime-grants.sql, applied by
-- the migrator in the same run.

CREATE POLICY memberships_delete_manager ON nexora.organization_memberships
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND user_id <> nexora.current_user_id()
    AND role <> 'owner'
    AND nexora.is_current_organization_manager(organization_id)
  );

CREATE POLICY memberships_delete_self ON nexora.organization_memberships
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
  );

CREATE POLICY project_memberships_delete_manager ON nexora.project_memberships
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_manager(organization_id)
  );

CREATE POLICY project_memberships_delete_self ON nexora.project_memberships
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
  );

CREATE POLICY notification_preferences_delete_manager ON nexora.notification_preferences
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_manager(organization_id)
  );

CREATE POLICY notification_preferences_delete_self ON nexora.notification_preferences
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
  );

CREATE POLICY invitations_delete_manager ON nexora.organization_invitations
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_manager(organization_id)
  );

-- Self-leave must also be able to clear the leaver's own pending
-- invitations; without this, a member with a stray pending invitation
-- would hit a 42501 on leave. The email match keeps this to the
-- caller's own invitations only, never anyone else's.
CREATE POLICY invitations_delete_self ON nexora.organization_invitations
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND email = (
      SELECT email FROM nexora.users WHERE id = nexora.current_user_id()
    )
  );
