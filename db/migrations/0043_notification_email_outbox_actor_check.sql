-- Correction to 0040/0042: the outbox enqueue function verified
-- its notification by SELECTing nexora.notifications, but that
-- table has FORCE ROW LEVEL SECURITY with a select policy that
-- only allows the RECIPIENT to select a row. An actor who just
-- created a notification therefore cannot SELECT it, even from a
-- SECURITY DEFINER function (FORCE RLS applies to the owner too),
-- so every email enqueue failed with 42501 and rolled back the
-- whole mutation. The notification SELECT is not needed for
-- safety: the outbox row has a FOREIGN KEY to notifications(id),
-- so a bogus notification id fails with a FK violation, and the
-- only caller is notifyProjectMember, immediately after a
-- successful enqueue_project_notification call that already
-- verified actor = current user and can_work on the project.
-- This replacement checks what the outbox function can check
-- without hitting the FORCE-RLS select policy: the organization
-- matches the tenant context, and the caller is an active member
-- of that organization. The FK check remains as the notification
-- existence check.
CREATE OR REPLACE FUNCTION nexora.enqueue_notification_email_outbox(
  target_notification_id uuid,
  target_organization_id uuid,
  target_recipient_user_id uuid,
  target_event_type text,
  target_title text,
  target_body text,
  target_href text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  outbox_id uuid;
BEGIN
  IF nexora.current_organization_id() IS DISTINCT FROM target_organization_id THEN
    RAISE EXCEPTION 'notification email enqueue: organization mismatch' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.user_id = nexora.current_user_id()
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'notification email enqueue: caller is not an active member' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM nexora.organization_memberships AS membership
    WHERE membership.organization_id = target_organization_id
      AND membership.user_id = target_recipient_user_id
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'notification email enqueue: recipient is not an active member' USING ERRCODE = '42501';
  END IF;
  INSERT INTO nexora.notification_email_outbox (
    notification_id, organization_id, recipient_user_id,
    event_type, title, body, href
  )
  VALUES (
    target_notification_id, target_organization_id, target_recipient_user_id,
    target_event_type, target_title, target_body, target_href
  )
  ON CONFLICT (notification_id) DO NOTHING
  RETURNING id INTO outbox_id;
  RETURN outbox_id;
END;
$function$;

REVOKE ALL ON FUNCTION nexora.enqueue_notification_email_outbox(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.enqueue_notification_email_outbox(uuid, uuid, uuid, text, text, text, text) TO nexora_app;
