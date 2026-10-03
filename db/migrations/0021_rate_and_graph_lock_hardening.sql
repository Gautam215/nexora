CREATE TABLE nexora.project_dependency_graph_locks (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  graph_type text NOT NULL,
  generation bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, project_id, graph_type),
  CONSTRAINT project_dependency_graph_lock_type
    CHECK (graph_type IN ('milestone', 'task')),
  CONSTRAINT project_dependency_graph_lock_generation
    CHECK (generation >= 0),
  CONSTRAINT project_dependency_graph_lock_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE CASCADE
);

REVOKE ALL ON TABLE nexora.project_dependency_graph_locks FROM PUBLIC;
REVOKE ALL ON TABLE nexora.project_dependency_graph_locks FROM nexora_app;

CREATE FUNCTION nexora.lock_project_dependency_graph(
  target_organization_id uuid,
  target_project_id uuid,
  target_graph_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF target_organization_id IS DISTINCT FROM nexora.current_organization_id()
    OR (
      target_graph_type = 'milestone'
      AND NOT nexora.can_manage_current_project(target_organization_id, target_project_id)
    )
    OR (
      target_graph_type = 'task'
      AND NOT nexora.can_work_current_project(target_organization_id, target_project_id)
    )
    OR target_graph_type NOT IN ('milestone', 'task') THEN
    RAISE EXCEPTION 'project graph access denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO nexora.project_dependency_graph_locks AS current_lock
    (organization_id, project_id, graph_type, generation)
  VALUES (target_organization_id, target_project_id, target_graph_type, 1)
  ON CONFLICT (organization_id, project_id, graph_type) DO UPDATE
  SET generation = current_lock.generation + 1;
END
$function$;

REVOKE ALL ON FUNCTION nexora.lock_project_dependency_graph(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.lock_project_dependency_graph(uuid, uuid, text) TO nexora_app;

CREATE FUNCTION nexora.acquire_dependency_graph_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.concat(
        CASE TG_ARGV[0]
          WHEN 'milestone' THEN 'milestone-dependency-graph:'
          WHEN 'task' THEN 'project-task-graph:'
          ELSE 'invalid-dependency-graph:'
        END,
        NEW.organization_id::text,
        ':',
        NEW.project_id::text
      ),
      0
    )
  );

  PERFORM nexora.lock_project_dependency_graph(
    NEW.organization_id,
    NEW.project_id,
    TG_ARGV[0]
  );
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION nexora.acquire_dependency_graph_lock() FROM PUBLIC;

CREATE TRIGGER milestone_dependencies_graph_lock
  BEFORE INSERT ON nexora.milestone_dependencies
  FOR EACH ROW EXECUTE FUNCTION nexora.acquire_dependency_graph_lock('milestone');

CREATE TRIGGER task_dependencies_graph_lock
  BEFORE INSERT ON nexora.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION nexora.acquire_dependency_graph_lock('task');

CREATE TRIGGER tasks_graph_lock_before_write
  BEFORE INSERT OR UPDATE OF workflow_status_id, parent_task_id, milestone_id, archived_at
  ON nexora.tasks
  FOR EACH ROW EXECUTE FUNCTION nexora.acquire_dependency_graph_lock('task');

CREATE OR REPLACE FUNCTION nexora.guard_milestone_dependency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.concat('milestone-dependency-graph:', NEW.organization_id::text, ':', NEW.project_id::text),
      0
    )
  );

  IF EXISTS (
    WITH RECURSIVE dependency_chain(milestone_id) AS (
      SELECT dependency.depends_on_milestone_id
      FROM nexora.milestone_dependencies AS dependency
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.project_id = NEW.project_id
        AND dependency.milestone_id = NEW.depends_on_milestone_id
      UNION
      SELECT dependency.depends_on_milestone_id
      FROM nexora.milestone_dependencies AS dependency
      JOIN dependency_chain AS chain
        ON dependency.milestone_id = chain.milestone_id
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.project_id = NEW.project_id
    )
    SELECT 1
    FROM dependency_chain
    WHERE milestone_id = NEW.milestone_id
  ) THEN
    RAISE EXCEPTION 'milestone dependency cycle detected'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION nexora.consume_auth_rate_limit(
  target_scope text,
  target_subject_hash text,
  max_attempts integer,
  window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  new_attempt_count integer;
BEGIN
  IF target_scope NOT IN (
      'register-email',
      'login-email',
      'verification-email',
      'verify-token',
      'password-reset-email',
      'password-reset-token',
      'organization-create-user',
      'organization-invite-user',
      'organization-invite-email',
      'organization-invitation-token',
      'project-management-user',
      'workspace-search',
      'task-file-upload'
    )
    OR target_subject_hash !~ '^[0-9a-f]{64}$'
    OR max_attempts NOT BETWEEN 1 AND 120
    OR window_seconds NOT BETWEEN 60 AND 86400 THEN
    RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO nexora.auth_rate_limits AS current_bucket
    (scope, subject_hash, window_started_at, attempts, expires_at)
  VALUES (
    target_scope,
    target_subject_hash,
    v_now,
    1,
    v_now + pg_catalog.make_interval(secs => window_seconds)
  )
  ON CONFLICT (scope, subject_hash) DO UPDATE
  SET attempts = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN 1
        ELSE LEAST(current_bucket.attempts + 1, 1000)
      END,
      window_started_at = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN v_now
        ELSE current_bucket.window_started_at
      END,
      expires_at = CASE
        WHEN current_bucket.window_started_at
          <= v_now - pg_catalog.make_interval(secs => window_seconds)
          THEN v_now + pg_catalog.make_interval(secs => window_seconds)
        ELSE current_bucket.expires_at
      END
  RETURNING attempts INTO new_attempt_count;

  RETURN new_attempt_count <= max_attempts;
END
$function$;
