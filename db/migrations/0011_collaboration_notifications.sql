ALTER TABLE nexora.task_comments
  ADD CONSTRAINT task_comments_resource_unique
  UNIQUE (organization_id, project_id, task_id, id);

CREATE TABLE nexora.task_comment_mentions (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  comment_id uuid NOT NULL,
  mentioned_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (organization_id, project_id, comment_id, mentioned_user_id),
  CONSTRAINT task_comment_mentions_comment_fk
    FOREIGN KEY (organization_id, project_id, task_id, comment_id)
    REFERENCES nexora.task_comments (organization_id, project_id, task_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT task_comment_mentions_project_member_fk
    FOREIGN KEY (organization_id, project_id, mentioned_user_id)
    REFERENCES nexora.project_memberships (organization_id, project_id, user_id)
    ON DELETE RESTRICT
);

CREATE INDEX task_comment_mentions_by_user
  ON nexora.task_comment_mentions (organization_id, mentioned_user_id, created_at DESC);

CREATE TABLE nexora.notification_preferences (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  in_app_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (organization_id, user_id, event_type),
  CONSTRAINT notification_preferences_member_fk
    FOREIGN KEY (organization_id, user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT notification_preferences_event_type CHECK (
    event_type IN ('mention', 'task_assigned', 'project_activity', 'due_date', 'ai_workflow')
  )
);

CREATE TABLE nexora.notifications (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  recipient_user_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  event_type text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  href text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  read_at timestamptz,
  CONSTRAINT notifications_dedupe_unique
    UNIQUE (organization_id, recipient_user_id, dedupe_key),
  CONSTRAINT notifications_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT notifications_recipient_fk
    FOREIGN KEY (organization_id, recipient_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT notifications_actor_fk
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT notifications_event_type CHECK (
    event_type IN ('mention', 'task_assigned', 'project_activity', 'due_date', 'ai_workflow')
  ),
  CONSTRAINT notifications_target_type CHECK (
    target_type IN ('task', 'project', 'milestone', 'project_membership')
  ),
  CONSTRAINT notifications_dedupe_key_length CHECK (
    pg_catalog.length(dedupe_key) BETWEEN 1 AND 180
  ),
  CONSTRAINT notifications_title_length CHECK (
    pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 120
  ),
  CONSTRAINT notifications_body_length CHECK (
    pg_catalog.length(body) BETWEEN 1 AND 500
  ),
  CONSTRAINT notifications_internal_href CHECK (
    href ~ '^/organizations/[0-9a-f-]{36}/projects/[0-9a-f-]{36}/(tasks|activity|milestones)([/?#].*)?$'
  )
);

CREATE INDEX notifications_by_recipient_unread
  ON nexora.notifications (organization_id, recipient_user_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;
CREATE INDEX notifications_by_recipient_time
  ON nexora.notifications (organization_id, recipient_user_id, created_at DESC, id DESC);

ALTER TABLE nexora.task_comment_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY task_comment_mentions_select_project_member ON nexora.task_comment_mentions
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY task_comment_mentions_insert_comment_author ON nexora.task_comment_mentions
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND nexora.can_work_current_project(organization_id, project_id)
    AND EXISTS (
      SELECT 1 FROM nexora.task_comments AS comment
      WHERE comment.organization_id = task_comment_mentions.organization_id
        AND comment.project_id = task_comment_mentions.project_id
        AND comment.task_id = task_comment_mentions.task_id
        AND comment.id = task_comment_mentions.comment_id
        AND comment.author_user_id = nexora.current_user_id()
    )
  );

CREATE POLICY notification_preferences_select_self ON nexora.notification_preferences
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY notification_preferences_insert_self ON nexora.notification_preferences
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY notification_preferences_update_self ON nexora.notification_preferences
  FOR UPDATE USING (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND user_id = nexora.current_user_id()
    AND nexora.is_current_organization_member(organization_id)
  );

CREATE POLICY notifications_select_recipient ON nexora.notifications
  FOR SELECT USING (
    organization_id = nexora.current_organization_id()
    AND recipient_user_id = nexora.current_user_id()
    AND nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY notifications_insert_project_member ON nexora.notifications
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
    AND recipient_user_id <> actor_user_id
    AND nexora.can_work_current_project(organization_id, project_id)
    AND EXISTS (
      SELECT 1 FROM nexora.project_memberships AS membership
      WHERE membership.organization_id = notifications.organization_id
        AND membership.project_id = notifications.project_id
        AND membership.user_id = notifications.recipient_user_id
        AND membership.status = 'active'
    )
  );

CREATE POLICY notifications_update_recipient ON nexora.notifications
  FOR UPDATE USING (
    organization_id = nexora.current_organization_id()
    AND recipient_user_id = nexora.current_user_id()
    AND nexora.can_access_current_project(organization_id, project_id)
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND recipient_user_id = nexora.current_user_id()
    AND nexora.can_access_current_project(organization_id, project_id)
  );

CREATE FUNCTION nexora.enqueue_project_notification(
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

  INSERT INTO nexora.notifications (
    id, organization_id, project_id, recipient_user_id, actor_user_id,
    event_type, target_type, target_id, dedupe_key, title, body, href
  )
  VALUES (
    pg_catalog.gen_random_uuid(), target_organization_id, target_project_id,
    target_recipient_user_id, target_actor_user_id, target_event_type,
    target_type, target_id, target_dedupe_key, target_title, target_body, target_href
  )
  ON CONFLICT (organization_id, recipient_user_id, dedupe_key) DO NOTHING
  RETURNING id INTO created_notification_id;

  RETURN created_notification_id;
END
$function$;

REVOKE ALL ON FUNCTION nexora.enqueue_project_notification(
  uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text
) FROM PUBLIC;
