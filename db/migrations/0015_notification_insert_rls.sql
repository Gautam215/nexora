CREATE OR REPLACE FUNCTION nexora.enqueue_project_notification(
  target_organization_id uuid,
  target_project_id uuid,
  target_recipient_user_id uuid,
  target_actor_user_id uuid,
  target_event_type text,
  target_type text,
  target_id uuid,
  target_dedupe_key text,
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
  created_notification_id uuid;
BEGIN
  IF target_organization_id IS DISTINCT FROM nexora.current_organization_id()
    OR target_actor_user_id IS DISTINCT FROM nexora.current_user_id()
    OR NOT nexora.can_work_current_project(target_organization_id, target_project_id) THEN
    RAISE EXCEPTION 'notification actor is not authorized' USING ERRCODE = '42501';
  END IF;

  IF target_recipient_user_id = target_actor_user_id
    OR NOT EXISTS (
      SELECT 1 FROM nexora.project_memberships AS membership
      WHERE membership.organization_id = target_organization_id
        AND membership.project_id = target_project_id
        AND membership.user_id = target_recipient_user_id
        AND membership.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM nexora.notification_preferences AS preference
      WHERE preference.organization_id = target_organization_id
        AND preference.user_id = target_recipient_user_id
        AND preference.event_type = target_event_type
        AND NOT preference.in_app_enabled
    ) THEN
    RETURN NULL;
  END IF;

  created_notification_id := pg_catalog.gen_random_uuid();
  INSERT INTO nexora.notifications (
    id, organization_id, project_id, recipient_user_id, actor_user_id,
    event_type, target_type, target_id, dedupe_key, title, body, href
  )
  VALUES (
    created_notification_id, target_organization_id, target_project_id,
    target_recipient_user_id, target_actor_user_id, target_event_type,
    target_type, target_id, target_dedupe_key, target_title, target_body, target_href
  )
  ON CONFLICT (organization_id, recipient_user_id, dedupe_key) DO NOTHING;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN created_notification_id;
END
$function$;
