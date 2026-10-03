CREATE TYPE nexora.task_priority AS ENUM ('low', 'medium', 'high', 'urgent');

ALTER TABLE nexora.projects
  ADD COLUMN task_workflow_version integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT projects_task_workflow_version_positive CHECK (task_workflow_version >= 1);

CREATE TABLE nexora.project_task_statuses (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL,
  is_done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT project_task_statuses_project_id_unique UNIQUE (organization_id, project_id, id),
  CONSTRAINT project_task_statuses_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT project_task_statuses_order_unique
    UNIQUE (organization_id, project_id, sort_order) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT project_task_statuses_name_length CHECK (
    pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 60
  ),
  CONSTRAINT project_task_statuses_order CHECK (sort_order BETWEEN 0 AND 1000)
);

CREATE UNIQUE INDEX project_task_statuses_name
  ON nexora.project_task_statuses (organization_id, project_id, pg_catalog.lower(name));
CREATE UNIQUE INDEX project_task_statuses_one_done
  ON nexora.project_task_statuses (organization_id, project_id)
  WHERE is_done;
CREATE INDEX project_task_statuses_by_project
  ON nexora.project_task_statuses (organization_id, project_id, sort_order, id);

CREATE FUNCTION nexora.seed_project_task_workflow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  INSERT INTO nexora.project_task_statuses
    (id, organization_id, project_id, name, sort_order, is_done)
  VALUES
    (pg_catalog.gen_random_uuid(), NEW.organization_id, NEW.id, 'Backlog', 0, false),
    (pg_catalog.gen_random_uuid(), NEW.organization_id, NEW.id, 'To do', 1, false),
    (pg_catalog.gen_random_uuid(), NEW.organization_id, NEW.id, 'In progress', 2, false),
    (pg_catalog.gen_random_uuid(), NEW.organization_id, NEW.id, 'In review', 3, false),
    (pg_catalog.gen_random_uuid(), NEW.organization_id, NEW.id, 'Done', 4, true);
  RETURN NEW;
END
$function$;

CREATE TRIGGER projects_seed_task_workflow
  AFTER INSERT ON nexora.projects
  FOR EACH ROW EXECUTE FUNCTION nexora.seed_project_task_workflow();

REVOKE ALL ON FUNCTION nexora.seed_project_task_workflow() FROM PUBLIC;

INSERT INTO nexora.project_task_statuses
  (id, organization_id, project_id, name, sort_order, is_done)
SELECT pg_catalog.gen_random_uuid(), project.organization_id, project.id,
       workflow.name, workflow.sort_order, workflow.is_done
FROM nexora.projects AS project
CROSS JOIN (
  VALUES
    ('Backlog', 0, false),
    ('To do', 1, false),
    ('In progress', 2, false),
    ('In review', 3, false),
    ('Done', 4, true)
) AS workflow(name, sort_order, is_done);

CREATE FUNCTION nexora.ensure_project_task_workflow_has_done_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  target_organization_id uuid;
  target_project_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_organization_id := OLD.organization_id;
    target_project_id := OLD.project_id;
  ELSE
    target_organization_id := NEW.organization_id;
    target_project_id := NEW.project_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM nexora.projects AS project
    WHERE project.organization_id = target_organization_id
      AND project.id = target_project_id
  ) AND NOT EXISTS (
    SELECT 1 FROM nexora.project_task_statuses AS workflow
    WHERE workflow.organization_id = target_organization_id
      AND workflow.project_id = target_project_id
      AND workflow.is_done
  ) THEN
    RAISE EXCEPTION 'project workflow must contain a completion status'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER project_task_workflow_requires_done_status
  AFTER INSERT OR UPDATE OR DELETE ON nexora.project_task_statuses
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nexora.ensure_project_task_workflow_has_done_status();

CREATE FUNCTION nexora.touch_project_task_status_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER project_task_statuses_touch_updated_at
  BEFORE UPDATE ON nexora.project_task_statuses
  FOR EACH ROW EXECUTE FUNCTION nexora.touch_project_task_status_updated_at();

CREATE TABLE nexora.tasks (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  workflow_status_id uuid NOT NULL,
  priority nexora.task_priority NOT NULL DEFAULT 'medium',
  assignee_user_id uuid,
  milestone_id uuid,
  parent_task_id uuid,
  labels text[] NOT NULL DEFAULT ARRAY[]::text[],
  due_date date,
  estimated_effort_hours numeric(7, 2),
  created_by_user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT tasks_project_id_unique UNIQUE (organization_id, project_id, id),
  CONSTRAINT tasks_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT tasks_workflow_status_fk
    FOREIGN KEY (organization_id, project_id, workflow_status_id)
    REFERENCES nexora.project_task_statuses (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT tasks_assignee_membership_fk
    FOREIGN KEY (organization_id, project_id, assignee_user_id)
    REFERENCES nexora.project_memberships (organization_id, project_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT tasks_milestone_fk
    FOREIGN KEY (organization_id, project_id, milestone_id)
    REFERENCES nexora.milestones (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT tasks_parent_task_fk
    FOREIGN KEY (organization_id, project_id, parent_task_id)
    REFERENCES nexora.tasks (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT tasks_parent_not_self CHECK (parent_task_id IS NULL OR parent_task_id <> id),
  CONSTRAINT tasks_creator_membership_fk
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT tasks_title_length CHECK (
    pg_catalog.length(pg_catalog.btrim(title)) BETWEEN 1 AND 200
  ),
  CONSTRAINT tasks_description_length CHECK (
    description IS NULL OR pg_catalog.length(description) <= 20000
  ),
  CONSTRAINT tasks_labels_bounded CHECK (
    pg_catalog.cardinality(labels) <= 12 AND pg_catalog.array_position(labels, '') IS NULL
  ),
  CONSTRAINT tasks_effort_nonnegative CHECK (
    estimated_effort_hours IS NULL OR estimated_effort_hours BETWEEN 0 AND 99999.99
  ),
  CONSTRAINT tasks_version_positive CHECK (version >= 1)
);

CREATE INDEX tasks_by_project_milestone
  ON nexora.tasks (organization_id, project_id, milestone_id, archived_at);
CREATE INDEX tasks_by_project_parent
  ON nexora.tasks (organization_id, project_id, parent_task_id, archived_at);
CREATE INDEX tasks_by_project_assignee
  ON nexora.tasks (organization_id, project_id, assignee_user_id, archived_at);
CREATE INDEX tasks_by_project_due_date
  ON nexora.tasks (organization_id, project_id, due_date, id)
  WHERE archived_at IS NULL;
CREATE INDEX tasks_labels_gin
  ON nexora.tasks USING gin (labels);

CREATE TABLE nexora.task_dependencies (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  depends_on_task_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (organization_id, project_id, task_id, depends_on_task_id),
  CONSTRAINT task_dependencies_not_self CHECK (task_id <> depends_on_task_id),
  CONSTRAINT task_dependencies_source_fk
    FOREIGN KEY (organization_id, project_id, task_id)
    REFERENCES nexora.tasks (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT task_dependencies_target_fk
    FOREIGN KEY (organization_id, project_id, depends_on_task_id)
    REFERENCES nexora.tasks (organization_id, project_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX task_dependencies_by_target
  ON nexora.task_dependencies (organization_id, project_id, depends_on_task_id, task_id);

CREATE FUNCTION nexora.can_work_current_project(
  target_organization_id uuid,
  target_project_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT target_organization_id = nexora.current_organization_id()
    AND nexora.is_current_organization_member(target_organization_id)
    AND EXISTS (
      SELECT 1
      FROM nexora.projects AS project
      WHERE project.organization_id = target_organization_id
        AND project.id = target_project_id
        AND (
          project.owner_user_id = nexora.current_user_id()
          OR nexora.is_current_organization_manager(target_organization_id)
          OR EXISTS (
            SELECT 1
            FROM nexora.project_memberships AS membership
            WHERE membership.organization_id = target_organization_id
              AND membership.project_id = target_project_id
              AND membership.user_id = nexora.current_user_id()
              AND membership.role IN ('manager', 'member')
              AND membership.status = 'active'
          )
        )
    )
$function$;

CREATE FUNCTION nexora.guard_task_dependency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.concat('project-task-graph:', NEW.organization_id::text, ':', NEW.project_id::text),
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM nexora.tasks AS task
    WHERE task.organization_id = NEW.organization_id
      AND task.project_id = NEW.project_id
      AND task.id IN (NEW.task_id, NEW.depends_on_task_id)
      AND task.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'archived tasks cannot participate in dependencies'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH RECURSIVE dependency_chain(task_id) AS (
      SELECT dependency.depends_on_task_id
      FROM nexora.task_dependencies AS dependency
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.project_id = NEW.project_id
        AND dependency.task_id = NEW.depends_on_task_id
      UNION
      SELECT dependency.depends_on_task_id
      FROM nexora.task_dependencies AS dependency
      JOIN dependency_chain AS chain ON dependency.task_id = chain.task_id
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.project_id = NEW.project_id
    )
    SELECT 1 FROM dependency_chain WHERE task_id = NEW.task_id
  ) THEN
    RAISE EXCEPTION 'task dependency cycle detected'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER task_dependencies_guard_insert
  BEFORE INSERT ON nexora.task_dependencies
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_task_dependency();

CREATE FUNCTION nexora.guard_task_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  is_done_status boolean;
  was_done_status boolean := false;
  milestone_status text;
  old_milestone_status text;
  project_status text;
  parent_task record;
BEGIN
  IF TG_OP = 'INSERT'
    OR NEW.workflow_status_id IS DISTINCT FROM OLD.workflow_status_id
    OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id
    OR NEW.milestone_id IS DISTINCT FROM OLD.milestone_id
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.concat('project-task-graph:', NEW.organization_id::text, ':', NEW.project_id::text),
        0
      )
    );
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
  ) THEN
    RAISE EXCEPTION 'task identity fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT project.status::text INTO project_status
  FROM nexora.projects AS project
  WHERE project.organization_id = NEW.organization_id AND project.id = NEW.project_id;
  IF project_status IS NULL OR project_status IN ('completed', 'archived') THEN
    RAISE EXCEPTION 'tasks cannot change in a completed or archived project'
      USING ERRCODE = '23514';
  END IF;

  SELECT workflow.is_done INTO is_done_status
  FROM nexora.project_task_statuses AS workflow
  WHERE workflow.organization_id = NEW.organization_id
    AND workflow.project_id = NEW.project_id
    AND workflow.id = NEW.workflow_status_id;
  IF is_done_status IS NULL THEN
    RAISE EXCEPTION 'task workflow status is not available'
      USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT workflow.is_done INTO was_done_status
    FROM nexora.project_task_statuses AS workflow
    WHERE workflow.organization_id = OLD.organization_id
      AND workflow.project_id = OLD.project_id
      AND workflow.id = OLD.workflow_status_id;
  END IF;

  IF NEW.milestone_id IS NOT NULL THEN
    SELECT milestone.status::text INTO milestone_status
    FROM nexora.milestones AS milestone
    WHERE milestone.organization_id = NEW.organization_id
      AND milestone.project_id = NEW.project_id
      AND milestone.id = NEW.milestone_id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.milestone_id IS NOT NULL THEN
    SELECT milestone.status::text INTO old_milestone_status
    FROM nexora.milestones AS milestone
    WHERE milestone.organization_id = OLD.organization_id
      AND milestone.project_id = OLD.project_id
      AND milestone.id = OLD.milestone_id;
  END IF;
  IF TG_OP = 'INSERT' AND milestone_status = 'completed' THEN
    RAISE EXCEPTION 'tasks cannot change in a completed milestone'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
    AND (milestone_status = 'completed' OR old_milestone_status = 'completed')
    AND (
      NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.workflow_status_id IS DISTINCT FROM OLD.workflow_status_id
      OR NEW.priority IS DISTINCT FROM OLD.priority
      OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
      OR NEW.milestone_id IS DISTINCT FROM OLD.milestone_id
      OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id
      OR NEW.labels IS DISTINCT FROM OLD.labels
      OR NEW.due_date IS DISTINCT FROM OLD.due_date
      OR NEW.estimated_effort_hours IS DISTINCT FROM OLD.estimated_effort_hours
      OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
    ) THEN
    RAISE EXCEPTION 'tasks cannot change in a completed milestone'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT parent.parent_task_id,
           parent.milestone_id,
           parent.archived_at,
           parent_status.is_done AS is_done
    INTO parent_task
    FROM nexora.tasks AS parent
    JOIN nexora.project_task_statuses AS parent_status
      ON parent_status.organization_id = parent.organization_id
     AND parent_status.project_id = parent.project_id
     AND parent_status.id = parent.workflow_status_id
    WHERE parent.organization_id = NEW.organization_id
      AND parent.project_id = NEW.project_id
      AND parent.id = NEW.parent_task_id
    FOR UPDATE OF parent;
    IF NOT FOUND
      OR parent_task.parent_task_id IS NOT NULL
      OR parent_task.archived_at IS NOT NULL
      OR parent_task.is_done
      OR parent_task.milestone_id IS DISTINCT FROM NEW.milestone_id THEN
      RAISE EXCEPTION 'subtasks must belong to an active top-level task in the same milestone'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM nexora.tasks AS child
      WHERE child.organization_id = NEW.organization_id
        AND child.project_id = NEW.project_id
        AND child.parent_task_id = NEW.id
        AND child.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'a task with subtasks cannot become a subtask'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(NEW.labels) AS label(value)
    WHERE value <> pg_catalog.btrim(value)
       OR pg_catalog.length(value) NOT BETWEEN 1 AND 24
  ) OR (
    SELECT pg_catalog.count(DISTINCT pg_catalog.lower(value))
    FROM pg_catalog.unnest(NEW.labels) AS label(value)
  ) <> pg_catalog.cardinality(NEW.labels) THEN
    RAISE EXCEPTION 'task labels must be trimmed, unique, and at most 24 characters'
      USING ERRCODE = '23514';
  END IF;

  IF is_done_status THEN
    PERFORM dependency.id
    FROM nexora.task_dependencies AS edge
    JOIN nexora.tasks AS dependency
      ON dependency.organization_id = edge.organization_id
     AND dependency.project_id = edge.project_id
     AND dependency.id = edge.depends_on_task_id
    WHERE edge.organization_id = NEW.organization_id
      AND edge.project_id = NEW.project_id
      AND edge.task_id = NEW.id
    ORDER BY dependency.id
    FOR UPDATE OF dependency;

    IF EXISTS (
      SELECT 1
      FROM nexora.task_dependencies AS edge
      JOIN nexora.tasks AS dependency
        ON dependency.organization_id = edge.organization_id
       AND dependency.project_id = edge.project_id
       AND dependency.id = edge.depends_on_task_id
      JOIN nexora.project_task_statuses AS dependency_status
        ON dependency_status.organization_id = dependency.organization_id
       AND dependency_status.project_id = dependency.project_id
       AND dependency_status.id = dependency.workflow_status_id
      WHERE edge.organization_id = NEW.organization_id
        AND edge.project_id = NEW.project_id
        AND edge.task_id = NEW.id
        AND (NOT dependency_status.is_done OR dependency.archived_at IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'task prerequisites are incomplete'
      USING ERRCODE = '23514';
    END IF;

    PERFORM child.id
    FROM nexora.tasks AS child
    WHERE child.organization_id = NEW.organization_id
      AND child.project_id = NEW.project_id
      AND child.parent_task_id = NEW.id
      AND child.archived_at IS NULL
    ORDER BY child.id
    FOR UPDATE OF child;

    IF EXISTS (
      SELECT 1
      FROM nexora.tasks AS child
      JOIN nexora.project_task_statuses AS child_status
        ON child_status.organization_id = child.organization_id
       AND child_status.project_id = child.project_id
       AND child_status.id = child.workflow_status_id
      WHERE child.organization_id = NEW.organization_id
        AND child.project_id = NEW.project_id
        AND child.parent_task_id = NEW.id
        AND child.archived_at IS NULL
        AND NOT child_status.is_done
    ) THEN
      RAISE EXCEPTION 'subtasks are incomplete'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND was_done_status AND NOT is_done_status
    AND OLD.parent_task_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM nexora.tasks AS parent
      JOIN nexora.project_task_statuses AS parent_status
        ON parent_status.organization_id = parent.organization_id
       AND parent_status.project_id = parent.project_id
       AND parent_status.id = parent.workflow_status_id
      WHERE parent.organization_id = OLD.organization_id
        AND parent.project_id = OLD.project_id
        AND parent.id = OLD.parent_task_id
        AND parent_status.is_done
    ) THEN
    RAISE EXCEPTION 'reopen the parent task before reopening this subtask'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND was_done_status AND NOT is_done_status AND EXISTS (
    SELECT 1
    FROM nexora.task_dependencies AS edge
    JOIN nexora.tasks AS dependent
      ON dependent.organization_id = edge.organization_id
     AND dependent.project_id = edge.project_id
     AND dependent.id = edge.task_id
    JOIN nexora.project_task_statuses AS dependent_status
      ON dependent_status.organization_id = dependent.organization_id
     AND dependent_status.project_id = dependent.project_id
     AND dependent_status.id = dependent.workflow_status_id
    WHERE edge.organization_id = NEW.organization_id
      AND edge.project_id = NEW.project_id
      AND edge.depends_on_task_id = NEW.id
      AND dependent.archived_at IS NULL
      AND dependent_status.is_done
  ) THEN
    RAISE EXCEPTION 'completed dependent tasks must be reopened first'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.archived_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.archived_at IS NULL) THEN
    IF EXISTS (
      SELECT 1 FROM nexora.tasks AS child
      WHERE child.organization_id = NEW.organization_id
        AND child.project_id = NEW.project_id
        AND child.parent_task_id = NEW.id
        AND child.archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'archive subtasks before archiving their parent task'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM nexora.task_dependencies AS edge
      JOIN nexora.tasks AS dependent
        ON dependent.organization_id = edge.organization_id
       AND dependent.project_id = edge.project_id
       AND dependent.id = edge.task_id
      JOIN nexora.project_task_statuses AS dependent_status
        ON dependent_status.organization_id = dependent.organization_id
       AND dependent_status.project_id = dependent.project_id
       AND dependent_status.id = dependent.workflow_status_id
      WHERE edge.organization_id = NEW.organization_id
        AND edge.project_id = NEW.project_id
        AND edge.depends_on_task_id = NEW.id
        AND dependent.archived_at IS NULL
        AND NOT dependent_status.is_done
    ) THEN
      RAISE EXCEPTION 'reassign or complete dependent tasks before archiving this task'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF is_done_status THEN
    IF TG_OP = 'INSERT' OR NOT was_done_status THEN
      NEW.completed_at := pg_catalog.clock_timestamp();
    ELSE
      NEW.completed_at := OLD.completed_at;
    END IF;
  ELSE
    NEW.completed_at := NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER tasks_guard_write
  BEFORE INSERT OR UPDATE ON nexora.tasks
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_task_write();

CREATE FUNCTION nexora.guard_milestone_task_consistency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF EXISTS (
      SELECT 1
      FROM nexora.milestone_dependencies AS edge
      JOIN nexora.milestones AS prerequisite
        ON prerequisite.organization_id = edge.organization_id
       AND prerequisite.project_id = edge.project_id
       AND prerequisite.id = edge.depends_on_milestone_id
      WHERE edge.organization_id = NEW.organization_id
        AND edge.project_id = NEW.project_id
        AND edge.milestone_id = NEW.id
        AND prerequisite.status <> 'completed'
    ) THEN
      RAISE EXCEPTION 'milestone prerequisites are incomplete'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM nexora.tasks AS task
      JOIN nexora.project_task_statuses AS workflow
        ON workflow.organization_id = task.organization_id
       AND workflow.project_id = task.project_id
       AND workflow.id = task.workflow_status_id
      WHERE task.organization_id = NEW.organization_id
        AND task.project_id = NEW.project_id
        AND task.milestone_id = NEW.id
        AND task.archived_at IS NULL
        AND NOT workflow.is_done
    ) THEN
      RAISE EXCEPTION 'milestone tasks are incomplete'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD.status = 'completed' AND NEW.status = 'active' AND EXISTS (
    SELECT 1
    FROM nexora.milestone_dependencies AS edge
    JOIN nexora.milestones AS dependent
      ON dependent.organization_id = edge.organization_id
     AND dependent.project_id = edge.project_id
     AND dependent.id = edge.milestone_id
    WHERE edge.organization_id = NEW.organization_id
      AND edge.project_id = NEW.project_id
      AND edge.depends_on_milestone_id = NEW.id
      AND dependent.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'completed dependent milestones must be reopened first'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER milestones_guard_task_consistency
  BEFORE UPDATE OF status ON nexora.milestones
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_milestone_task_consistency();

CREATE FUNCTION nexora.guard_project_completion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF EXISTS (
      SELECT 1
      FROM nexora.tasks AS task
      JOIN nexora.project_task_statuses AS workflow
        ON workflow.organization_id = task.organization_id
       AND workflow.project_id = task.project_id
       AND workflow.id = task.workflow_status_id
      WHERE task.organization_id = NEW.organization_id
        AND task.project_id = NEW.id
        AND task.archived_at IS NULL
        AND NOT workflow.is_done
    ) OR EXISTS (
      SELECT 1
      FROM nexora.milestones AS milestone
      WHERE milestone.organization_id = NEW.organization_id
        AND milestone.project_id = NEW.id
        AND milestone.status <> 'completed'
    ) THEN
      RAISE EXCEPTION 'complete all active project work before completing the project'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER projects_completion_guard
  BEFORE UPDATE OF status ON nexora.projects
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_project_completion();

CREATE FUNCTION nexora.guard_task_status_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'workflow identity fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_done IS DISTINCT FROM OLD.is_done AND EXISTS (
    SELECT 1
    FROM nexora.tasks AS task
    WHERE task.organization_id = OLD.organization_id
      AND task.project_id = OLD.project_id
      AND task.workflow_status_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'completion behavior cannot change while tasks use this workflow column'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER project_task_statuses_guard_update
  BEFORE UPDATE ON nexora.project_task_statuses
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_task_status_write();

REVOKE ALL ON FUNCTION nexora.ensure_project_task_workflow_has_done_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.touch_project_task_status_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.can_work_current_project(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_task_dependency() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_task_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_milestone_task_consistency() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_project_completion() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_task_status_write() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION nexora.can_work_current_project(uuid, uuid) TO nexora_app;

ALTER TABLE nexora.project_task_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.task_dependencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_task_statuses_select_project_member ON nexora.project_task_statuses
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY project_task_statuses_insert_project_manager ON nexora.project_task_statuses
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY project_task_statuses_update_project_manager ON nexora.project_task_statuses
  FOR UPDATE USING (
    nexora.can_manage_current_project(organization_id, project_id)
  )
  WITH CHECK (
    nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY project_task_statuses_delete_project_manager ON nexora.project_task_statuses
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY tasks_select_project_member ON nexora.tasks
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY tasks_insert_project_member ON nexora.tasks
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND created_by_user_id = nexora.current_user_id()
    AND nexora.can_work_current_project(organization_id, project_id)
  );

CREATE POLICY tasks_update_project_member ON nexora.tasks
  FOR UPDATE USING (
    nexora.can_work_current_project(organization_id, project_id)
  )
  WITH CHECK (
    nexora.can_work_current_project(organization_id, project_id)
  );

CREATE POLICY task_dependencies_select_project_member ON nexora.task_dependencies
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY task_dependencies_insert_project_member ON nexora.task_dependencies
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND nexora.can_work_current_project(organization_id, project_id)
  );

CREATE POLICY task_dependencies_delete_project_member ON nexora.task_dependencies
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND nexora.can_work_current_project(organization_id, project_id)
  );
