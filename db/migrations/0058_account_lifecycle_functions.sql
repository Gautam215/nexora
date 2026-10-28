-- 0058_account_lifecycle_functions.sql
--
-- Account lifecycle helpers (PRD 27/28). Both run SECURITY DEFINER so
-- they can reach across the caller's workspaces: the app role sees
-- only its own membership rows under RLS, which cannot answer "is
-- this user the sole owner of any workspace?" or "export everything
-- I own across workspaces". Each function guards itself to the
-- caller (current_user_id() must equal the target) and raises 42501
-- otherwise, so the elevation cannot leak another user's data.
--
-- delete_user_account: scrub, do not hard-delete. The users row
-- anchors history with RESTRICT foreign keys (tasks created,
-- comments authored, files uploaded, audit events, AI executions),
-- so deleting it would fail for any user with a footprint and would
-- rewrite history if it succeeded. Effects, in order: (1) one audit
-- row per active workspace, written while the actor is still an
-- active member; (2) sessions and auth tokens deleted; (3)
-- notification preferences deleted; (4) pending invitations for the
-- user's email deleted (accepted ones stay as history); (5) tasks
-- assigned to the user unassigned everywhere; (6) project
-- memberships deleted except mention anchors (a mentioned user must
-- stay resolvable); (7) organization memberships DISABLED, not
-- deleted, so they remain as history anchors; (8) the user row is
-- scrubbed (email replaced by a unique deleted- address, display
-- name neutralized, password replaced by a random value, status
-- suspended, email_verified_at cleared, deleted_at stamped). A
-- sole-owner active workspace blocks deletion: the caller must
-- transfer ownership or delete the workspace first, and the blocker
-- slugs are returned so the route can name them. After the scrub,
-- login is impossible (status is not 'active') and no route can
-- unsuspend a user, so the deletion is final from the app.
--
-- export_user_data: the caller's own data across all workspaces as
-- one JSON document. File entries are metadata only (no storage key,
-- no signed link); AI execution entries are metadata only (prompts
-- and responses are never stored by design); notifications are
-- counts only (transient rows, not user-authored content).

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
    (organization_id, actor_user_id, action, target_type, target_id, details)
    SELECT membership.organization_id, target_user_id, 'account.deleted', 'user', target_user_id,
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

CREATE OR REPLACE FUNCTION nexora.export_user_data(target_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF nexora.current_user_id() IS DISTINCT FROM target_user_id THEN
    RAISE EXCEPTION 'account export is not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'profile', (
      SELECT pg_catalog.row_to_json(profile)
      FROM (
        SELECT account.id, account.email, account.display_name, account.status::text,
               account.email_verified_at, account.created_at
        FROM nexora.users AS account
        WHERE account.id = target_user_id
      ) AS profile
    ),
    'memberships', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(membership))
      FROM (
        SELECT organization.id AS organization_id, organization.name AS organization_name,
               organization.slug AS organization_slug, membership.role::text, membership.status::text,
               membership.joined_at
        FROM nexora.organization_memberships AS membership
        JOIN nexora.organizations AS organization ON organization.id = membership.organization_id
        WHERE membership.user_id = target_user_id
        ORDER BY organization.name
      ) AS membership
    ), '[]'::jsonb),
    'projects', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(project_row))
      FROM (
        SELECT project.id, project.organization_id, project.name, project.status::text,
               COALESCE(project_membership.role::text, 'owner') AS project_role
        FROM nexora.projects AS project
        LEFT JOIN nexora.project_memberships AS project_membership
          ON project_membership.organization_id = project.organization_id
          AND project_membership.project_id = project.id
          AND project_membership.user_id = target_user_id
        WHERE project.owner_user_id = target_user_id OR project_membership.user_id = target_user_id
        ORDER BY project.name
      ) AS project_row
    ), '[]'::jsonb),
    'tasks_created', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(task_row))
      FROM (
        SELECT task.id, task.organization_id, task.project_id, task.title,
               task_status.name AS status, task.created_at
        FROM nexora.tasks AS task
        JOIN nexora.project_task_statuses AS task_status
          ON task_status.organization_id = task.organization_id
          AND task_status.project_id = task.project_id
          AND task_status.id = task.workflow_status_id
        WHERE task.created_by_user_id = target_user_id
        ORDER BY task.created_at
      ) AS task_row
    ), '[]'::jsonb),
    'tasks_assigned', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(task_row))
      FROM (
        SELECT task.id, task.organization_id, task.project_id, task.title,
               task_status.name AS status, task.created_at
        FROM nexora.tasks AS task
        JOIN nexora.project_task_statuses AS task_status
          ON task_status.organization_id = task.organization_id
          AND task_status.project_id = task.project_id
          AND task_status.id = task.workflow_status_id
        WHERE task.assignee_user_id = target_user_id
        ORDER BY task.created_at
      ) AS task_row
    ), '[]'::jsonb),
    'comments', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(comment_row))
      FROM (
        SELECT comment.id, comment.organization_id, comment.project_id, comment.task_id,
               comment.body, comment.created_at
        FROM nexora.task_comments AS comment
        WHERE comment.author_user_id = target_user_id
        ORDER BY comment.created_at
      ) AS comment_row
    ), '[]'::jsonb),
    'files', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(file_row))
      FROM (
        SELECT file.id, file.organization_id, file.project_id, file.task_id,
               file.original_filename, file.mime_type, file.byte_size, file.created_at
        FROM nexora.task_files AS file
        WHERE file.uploaded_by_user_id = target_user_id
        ORDER BY file.created_at
      ) AS file_row
    ), '[]'::jsonb),
    'ai_executions', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.row_to_json(execution_row))
      FROM (
        SELECT execution.id, execution.organization_id, execution.project_id,
               execution.workflow::text, execution.provider::text, execution.model,
               execution.status::text, execution.prompt_tokens, execution.completion_tokens,
               execution.latency_ms, execution.created_at
        FROM nexora.ai_executions AS execution
        WHERE execution.user_id = target_user_id
        ORDER BY execution.created_at
      ) AS execution_row
    ), '[]'::jsonb),
    'notification_counts', (
      SELECT pg_catalog.row_to_json(counts)
      FROM (
        SELECT pg_catalog.count(*)::integer AS total,
               pg_catalog.count(*) FILTER (WHERE notification.read_at IS NULL)::integer AS unread
        FROM nexora.notifications AS notification
        WHERE notification.recipient_user_id = target_user_id
      ) AS counts
    )
  );
END
$function$;

REVOKE EXECUTE ON FUNCTION nexora.delete_user_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.delete_user_account(uuid) TO nexora_app;
REVOKE EXECUTE ON FUNCTION nexora.export_user_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.export_user_data(uuid) TO nexora_app;
