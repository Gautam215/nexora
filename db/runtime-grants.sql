-- Run as the migration owner after creating a dedicated `nexora_app` role.
-- The role must not own objects and must not have SUPERUSER or BYPASSRLS.
GRANT USAGE ON SCHEMA nexora TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.current_user_id() TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.current_organization_id() TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_current_organization_member(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_current_user_organization_creator(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_current_organization_manager(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.list_current_organization_members(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.accept_organization_invitation(text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.can_create_current_project(uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_active_organization_member(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.can_access_current_project(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.can_manage_current_project(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.is_project_owner(uuid, uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.list_current_project_members(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.can_work_current_project(uuid, uuid) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.enqueue_project_notification(uuid, uuid, uuid, uuid, text, text, uuid, text, text, text, text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.purge_expired_task_files() TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.list_unreferenced_task_file_keys(uuid[]) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.searchable_task_labels(text[]) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.lock_project_dependency_graph(uuid, uuid, text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.lock_active_task_file_for_download(uuid, uuid, uuid, uuid) TO nexora_app;
GRANT USAGE ON TYPE
  nexora.user_status,
  nexora.organization_status,
  nexora.organization_role,
  nexora.membership_status,
  nexora.project_status,
  nexora.project_role,
  nexora.project_membership_status,
  nexora.milestone_status,
  nexora.task_priority
TO nexora_app;

REVOKE ALL PRIVILEGES ON TABLE
  nexora.users,
  nexora.user_sessions,
  nexora.organizations,
  nexora.organization_memberships,
  nexora.organization_invitations,
  nexora.projects,
  nexora.project_memberships,
  nexora.milestones,
  nexora.milestone_dependencies,
  nexora.project_mutation_idempotency,
  nexora.project_dependency_graph_locks,
  nexora.project_task_statuses,
  nexora.tasks,
  nexora.task_dependencies,
  nexora.task_comments,
  nexora.task_comment_mentions,
  nexora.notification_preferences,
  nexora.notifications,
  nexora.task_files,
  nexora.audit_events,
  nexora.schema_migrations
FROM nexora_app;

GRANT SELECT (id, email, display_name, status, email_verified_at, created_at, updated_at),
  INSERT (id, email, display_name, password_hash),
  UPDATE (display_name, password_hash)
ON TABLE nexora.users TO nexora_app;

GRANT SELECT (id, user_id, created_at, last_seen_at, expires_at, revoked_at),
  INSERT (id, user_id, token_hash, expires_at),
  UPDATE (last_seen_at, revoked_at)
ON TABLE nexora.user_sessions TO nexora_app;

GRANT SELECT (id, name, slug, status, created_by, created_at, updated_at),
  INSERT (id, name, slug, created_by),
  UPDATE (name, slug, status)
ON TABLE nexora.organizations TO nexora_app;

GRANT SELECT (organization_id, user_id, role, status, invited_by, joined_at, created_at, updated_at),
  INSERT (organization_id, user_id, role, status, invited_by, joined_at),
  UPDATE (role, status)
ON TABLE nexora.organization_memberships TO nexora_app;

GRANT SELECT (id, organization_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at),
  INSERT (id, organization_id, email, role, token_hash, invited_by, expires_at),
  UPDATE (accepted_at, revoked_at)
ON TABLE nexora.organization_invitations TO nexora_app;

GRANT SELECT (
    id, organization_id, name, description, status, owner_user_id,
    start_date, target_date, version, task_workflow_version, created_at, updated_at
  ),
  INSERT (
    id, organization_id, name, description, owner_user_id,
    start_date, target_date
  ),
  UPDATE (name, description, status, start_date, target_date, task_workflow_version)
ON TABLE nexora.projects TO nexora_app;

GRANT SELECT (
    organization_id, project_id, user_id, role, status,
    added_by_user_id, created_at, updated_at
  ),
  INSERT (
    organization_id, project_id, user_id, role, status, added_by_user_id
  ),
  UPDATE (role, status)
ON TABLE nexora.project_memberships TO nexora_app;

GRANT SELECT (
    id, organization_id, project_id, name, description, start_date, end_date,
    status, created_by_user_id, version, completed_at, created_at, updated_at
  ),
  INSERT (
    id, organization_id, project_id, name, description, start_date, end_date,
    created_by_user_id
  ),
  UPDATE (name, description, start_date, end_date, status)
ON TABLE nexora.milestones TO nexora_app;

GRANT SELECT (
    organization_id, project_id, milestone_id, depends_on_milestone_id, created_at
  ),
  INSERT (organization_id, project_id, milestone_id, depends_on_milestone_id),
  DELETE
ON TABLE nexora.milestone_dependencies TO nexora_app;

GRANT SELECT (
    organization_id, project_id, actor_user_id, operation, key_hash, request_hash,
    response_status, response_body, created_at, expires_at
  ),
  INSERT (
    organization_id, project_id, actor_user_id, operation, key_hash, request_hash,
    response_status, response_body
  ),
  DELETE
ON TABLE nexora.project_mutation_idempotency TO nexora_app;

GRANT SELECT (
    id, organization_id, project_id, name, sort_order, is_done, created_at, updated_at
  ),
  INSERT (id, organization_id, project_id, name, sort_order, is_done),
  UPDATE (name, sort_order, is_done),
  DELETE
ON TABLE nexora.project_task_statuses TO nexora_app;

GRANT SELECT (
    id, organization_id, project_id, title, description, workflow_status_id, priority,
    assignee_user_id, milestone_id, parent_task_id, labels, due_date,
    estimated_effort_hours, position, created_by_user_id, version, completed_at,
    archived_at, created_at, updated_at
  ),
  INSERT (
    id, organization_id, project_id, title, description, workflow_status_id, priority,
    assignee_user_id, milestone_id, parent_task_id, labels, due_date,
    estimated_effort_hours, position, created_by_user_id
  ),
  UPDATE (
    title, description, workflow_status_id, priority, assignee_user_id, milestone_id,
    parent_task_id, labels, due_date, estimated_effort_hours, position, archived_at
  )
ON TABLE nexora.tasks TO nexora_app;

GRANT SELECT (
    organization_id, project_id, task_id, depends_on_task_id, created_at
  ),
  INSERT (organization_id, project_id, task_id, depends_on_task_id),
  DELETE
ON TABLE nexora.task_dependencies TO nexora_app;

GRANT SELECT (
    id, organization_id, project_id, task_id, author_user_id, body, created_at
  ),
  INSERT (id, organization_id, project_id, task_id, author_user_id, body)
ON TABLE nexora.task_comments TO nexora_app;

GRANT SELECT (
    organization_id, project_id, task_id, comment_id, mentioned_user_id, created_at
  ),
  INSERT (organization_id, project_id, task_id, comment_id, mentioned_user_id)
ON TABLE nexora.task_comment_mentions TO nexora_app;

GRANT SELECT (organization_id, user_id, event_type, in_app_enabled, updated_at),
  INSERT (organization_id, user_id, event_type, in_app_enabled),
  UPDATE (in_app_enabled, updated_at)
ON TABLE nexora.notification_preferences TO nexora_app;

GRANT SELECT (
    id, organization_id, project_id, recipient_user_id, actor_user_id,
    event_type, target_type, target_id, dedupe_key, title, body, href, created_at, read_at
  ),
  UPDATE (read_at)
ON TABLE nexora.notifications TO nexora_app;

GRANT SELECT (
    id, organization_id, project_id, task_id, original_filename, mime_type,
    byte_size, sha256, storage_key, uploaded_by_user_id, version,
    created_at, updated_at, deleted_at, deleted_by_user_id
  ),
  INSERT (
    id, organization_id, project_id, task_id, original_filename, mime_type,
    byte_size, sha256, storage_key, uploaded_by_user_id
  ),
  UPDATE (
    original_filename, mime_type, byte_size, sha256, storage_key,
    version, updated_at, deleted_at, deleted_by_user_id
  )
ON TABLE nexora.task_files TO nexora_app;

GRANT SELECT (id, organization_id, actor_user_id, action, target_type, target_id, details, created_at),
  INSERT (id, organization_id, actor_user_id, action, target_type, target_id, details)
ON TABLE nexora.audit_events TO nexora_app;

REVOKE UPDATE, DELETE, TRUNCATE ON nexora.audit_events FROM nexora_app;
REVOKE ALL ON nexora.schema_migrations FROM nexora_app;
