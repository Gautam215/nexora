-- Distinguish the authorization checks in
-- enqueue_notification_email_outbox: 0040 used one generic message
-- for both the organization check and the notification-actor check,
-- which made a 42501 impossible to diagnose from the server log
-- (the client still receives only a generic 500). This replacement
-- keeps the same checks and behaviour, with a distinct message per
-- check. Function replacement via a new migration is the normal
-- pattern here (see 0015/0016 for enqueue_project_notification).
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
    SELECT 1 FROM nexora.notifications AS notification
    WHERE notification.id = target_notification_id
      AND notification.organization_id = target_organization_id
      AND notification.recipient_user_id = target_recipient_user_id
      AND notification.actor_user_id = nexora.current_user_id()
  ) THEN
    RAISE EXCEPTION 'notification email enqueue: notification actor mismatch' USING ERRCODE = '42501';
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
