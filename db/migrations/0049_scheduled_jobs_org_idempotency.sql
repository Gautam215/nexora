-- 0049: Scheduled jobs, organization-creation idempotency, and the
-- narrow system-job exception for due-date reminders.
--
-- Scheduled jobs (see src/server/scheduled.ts and the cron route):
-- a daily run of each job is recorded in scheduled_job_runs, whose
-- (job, run_date) unique key makes a repeated run on the same day a
-- no-op replay instead of a second round of notifications or purges.
-- This table holds no tenant data, so — like schema_migrations — it
-- carries no row-level security; only the runtime role's grants in
-- db/runtime-grants.sql can write it.
--
-- Organization-creation idempotency follows the existing
-- project_mutation_idempotency pattern (0007, extended by 0037/0038),
-- scoped to the creating user instead of a project, because no
-- organization exists yet when the request is first made. A replay
-- with the same key and the same request body returns the stored
-- organization; a replay with a different body is a conflict.
--
-- Due-date system policy: the notifications insert policy in 0011
-- requires the actor to differ from the recipient, which a system
-- reminder cannot satisfy — a due-date reminder is, by definition,
-- addressed to the assignee themselves. The policy added here is
-- deliberately narrow: it permits an insert ONLY when
--   * the session flag nexora.system_job is exactly 'due-date'
--     (set transaction-locally by the token-gated cron route, and
--     by nothing else in the codebase),
--   * the event is 'due_date',
--   * actor and recipient are the same user,
--   * the organization matches the current organization context,
--   * the recipient can work on the project, and
--   * the recipient has not disabled due_date in-app notifications.
-- It does not permit any other event, any other actor, or any
-- insert without the flag. Policies are permissive-OR, so the
-- original policy is unchanged and still governs every user-driven
-- insert.
CREATE TABLE nexora.scheduled_job_runs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  job text NOT NULL
    CONSTRAINT scheduled_job_runs_job_check
    CHECK (job IN ('due-date', 'cleanup', 'email-outbox', 'alerts')),
  run_date date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL
    CONSTRAINT scheduled_job_runs_status_check
    CHECK (status IN ('ok', 'failed')),
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT scheduled_job_runs_daily_unique UNIQUE (job, run_date)
);

CREATE TABLE nexora.organization_creation_idempotency (
  actor_user_id uuid NOT NULL,
  operation text NOT NULL
    CONSTRAINT organization_creation_idempotency_operation_check
    CHECK (operation = 'organization.create'),
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  response_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL DEFAULT (pg_catalog.now() + interval '7 days'),
  PRIMARY KEY (actor_user_id, operation, key_hash),
  CONSTRAINT organization_creation_idempotency_actor_fk
    FOREIGN KEY (actor_user_id)
    REFERENCES nexora.users (id)
    ON DELETE RESTRICT,
  CONSTRAINT organization_creation_idempotency_hashes CHECK (
    key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT organization_creation_idempotency_status CHECK (
    response_status BETWEEN 200 AND 299
  ),
  CONSTRAINT organization_creation_idempotency_expiry CHECK (
    expires_at > created_at
  )
);

CREATE INDEX organization_creation_idempotency_expiry
  ON nexora.organization_creation_idempotency (expires_at);

ALTER TABLE nexora.organization_creation_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_creation_idempotency_select_actor
  ON nexora.organization_creation_idempotency
  FOR SELECT USING (actor_user_id = nexora.current_user_id());

CREATE POLICY organization_creation_idempotency_insert_actor
  ON nexora.organization_creation_idempotency
  FOR INSERT WITH CHECK (actor_user_id = nexora.current_user_id());

CREATE POLICY organization_creation_idempotency_delete_actor
  ON nexora.organization_creation_idempotency
  FOR DELETE USING (actor_user_id = nexora.current_user_id());

-- Due-date listing for the system job. SECURITY DEFINER like the
-- existing list_* functions: the cron route has no tenant session,
-- so a plain SELECT on tasks would return nothing under RLS. The
-- function returns only the fields the reminder needs, only for
-- tasks due tomorrow that are neither completed nor archived, in
-- active projects of active organizations.
CREATE FUNCTION nexora.list_due_date_tasks()
RETURNS TABLE (
  organization_id uuid,
  project_id uuid,
  task_id uuid,
  assignee_user_id uuid,
  task_title text,
  due_date date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT task.organization_id, task.project_id, task.id,
         task.assignee_user_id, task.title, task.due_date
  FROM nexora.tasks AS task
  JOIN nexora.projects AS project
    ON project.organization_id = task.organization_id
   AND project.id = task.project_id
  JOIN nexora.organizations AS organization
    ON organization.id = task.organization_id
  JOIN nexora.project_task_statuses AS workflow
    ON workflow.organization_id = task.organization_id
   AND workflow.project_id = task.project_id
   AND workflow.id = task.workflow_status_id
  WHERE task.assignee_user_id IS NOT NULL
    AND task.due_date = CURRENT_DATE + 1
    AND task.completed_at IS NULL
    AND task.archived_at IS NULL
    AND workflow.is_done = false
    AND project.status NOT IN ('completed', 'archived')
    AND organization.status = 'active'
$function$;

REVOKE ALL ON FUNCTION nexora.list_due_date_tasks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.list_due_date_tasks() TO nexora_app;

CREATE POLICY notifications_insert_system_due_date
  ON nexora.notifications
  FOR INSERT WITH CHECK (
    pg_catalog.current_setting('nexora.system_job', true) = 'due-date'
    AND event_type = 'due_date'
    AND actor_user_id = recipient_user_id
    AND organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
    AND nexora.can_work_current_project(organization_id, project_id)
    AND NOT EXISTS (
      SELECT 1 FROM nexora.notification_preferences AS preference
      WHERE preference.organization_id = notifications.organization_id
        AND preference.user_id = notifications.recipient_user_id
        AND preference.event_type = 'due_date'
        AND NOT preference.in_app_enabled
    )
  );

-- Alert deduplication state: one row per rule. An alert is sent
-- only when its value crosses a threshold it has not crossed
-- before (or, for database-down, at most once an hour), so a
-- recurring cron run cannot mail the operator in a loop.
CREATE TABLE nexora.alert_state (
  rule text PRIMARY KEY,
  last_value bigint NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
