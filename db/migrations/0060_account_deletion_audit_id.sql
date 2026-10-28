-- 0060_account_deletion_audit_id.sql
--
-- Correction for 0058 (0058 itself is never edited: it has already
-- run). The audit insert in delete_user_account omitted the id
-- column, and audit_events.id has no default, so every account
-- deletion failed with a NOT NULL violation (23502). This
-- redefinition adds the generated id and is otherwise identical to
-- 0058. Verified by the account-lifecycle integration test, which
-- failed on 0058 and passes on 0060.

CREATE OR REPLACE FUNCTION nexora.delete_user_account(target_user_id uuid)
RETURNS TABLE (deleted boolean, sole_owner_slugs text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  owner_slugs text[];
BEGIN
  IF nexora.current_user_id() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'account deletion is not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.array_agg(organization.slug)
    INTO owner_slugs
    FROM nexora.organizations AS organization
    WHERE organization.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM nexora.organization_memberships AS own
        WHERE own.organization_id = organization.id
          AND own.user_id = target_user_id
          AND own.role = 'owner'
          AND own.status = 'active'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM nexora.organization_memberships AS other_owner
        WHERE other_owner.organization_id = organization.id
          AND other_owner.user_id <> target_user_id
          AND other_owner.role = 'owner'
          AND other_owner.status = 'active'
      );

  IF owner_slugs IS NOT NULL THEN
    RETURN QUERY SELECT false, owner_slugs;
    RETURN;
  END IF;

  INSERT INTO nexora.audit_events
    (id, organization_id, actor_user_id, action, target_type, target_id, details)
    SELECT pg_catalog.gen_random_uuid(), membership.organization_id, target_user_id, 'account.deleted', 'user', target_user_id,
           pg_catalog.jsonb_build_object('selfDeleted', true)
      FROM nexora.organization_memberships AS membership
      WHERE membership.user_id = target_user_id
        AND membership.status = 'active';

  DELETE FROM nexora.user_sessions WHERE user_id = target_user_id;
  DELETE FROM nexora.email_verification_tokens WHERE user_id = target_user_id;
  DELETE FROM nexora.password_reset_tokens WHERE user_id = target_user_id;
  DELETE FROM nexora.notification_preferences WHERE user_id = target_user_id;
  DELETE FROM nexora.organization_invitations AS invitation
    WHERE invitation.accepted_at IS NULL
      AND invitation.revoked_at IS NULL
      AND invitation.email = (
        SELECT account.email FROM nexora.users AS account WHERE account.id = target_user_id
      );
  UPDATE nexora.tasks SET assignee_user_id = NULL WHERE assignee_user_id = target_user_id;
  DELETE FROM nexora.project_memberships AS project_membership
    WHERE project_membership.user_id = target_user_id
      AND NOT EXISTS (
        SELECT 1
        FROM nexora.task_comment_mentions AS mention
        WHERE mention.organization_id = project_membership.organization_id
          AND mention.project_id = project_membership.project_id
          AND mention.mentioned_user_id = target_user_id
      );
  UPDATE nexora.organization_memberships
    SET status = 'disabled'
    WHERE user_id = target_user_id;
  UPDATE nexora.users
    SET email = 'deleted-' || target_user_id::text || '@deleted.invalid',
        display_name = 'Deleted user',
        password_hash = pg_catalog.md5(pg_catalog.gen_random_uuid()::text),
        status = 'suspended',
        email_verified_at = NULL,
        deleted_at = pg_catalog.clock_timestamp()
    WHERE id = target_user_id;

  RETURN QUERY SELECT true, NULL::text[];
END
$function$;
