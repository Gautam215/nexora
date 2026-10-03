CREATE TYPE nexora.milestone_status AS ENUM (
  'planned',
  'active',
  'on_hold',
  'completed'
);

CREATE TABLE nexora.milestones (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  status nexora.milestone_status NOT NULL DEFAULT 'planned',
  created_by_user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT milestones_project_id_unique UNIQUE (organization_id, project_id, id),
  CONSTRAINT milestones_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT milestones_creator_membership_fk
    FOREIGN KEY (organization_id, created_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT milestones_name_length CHECK (
    pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 160
  ),
  CONSTRAINT milestones_description_length CHECK (
    description IS NULL OR pg_catalog.length(description) <= 10000
  ),
  CONSTRAINT milestones_date_range CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT milestones_version_positive CHECK (version >= 1)
);

CREATE INDEX milestones_by_project_status
  ON nexora.milestones (organization_id, project_id, status, end_date, id);

CREATE TABLE nexora.milestone_dependencies (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  milestone_id uuid NOT NULL,
  depends_on_milestone_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (organization_id, project_id, milestone_id, depends_on_milestone_id),
  CONSTRAINT milestone_dependencies_not_self CHECK (milestone_id <> depends_on_milestone_id),
  CONSTRAINT milestone_dependencies_source_fk
    FOREIGN KEY (organization_id, project_id, milestone_id)
    REFERENCES nexora.milestones (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT milestone_dependencies_target_fk
    FOREIGN KEY (organization_id, project_id, depends_on_milestone_id)
    REFERENCES nexora.milestones (organization_id, project_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX milestone_dependencies_by_target
  ON nexora.milestone_dependencies
    (organization_id, project_id, depends_on_milestone_id, milestone_id);

CREATE TABLE nexora.project_mutation_idempotency (
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  operation text NOT NULL,
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  response_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL DEFAULT (pg_catalog.now() + interval '7 days'),
  PRIMARY KEY (organization_id, project_id, actor_user_id, operation, key_hash),
  CONSTRAINT project_mutation_idempotency_project_fk
    FOREIGN KEY (organization_id, project_id)
    REFERENCES nexora.projects (organization_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT project_mutation_idempotency_actor_fk
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT project_mutation_idempotency_operation CHECK (
    operation IN ('milestone.create', 'task.create')
  ),
  CONSTRAINT project_mutation_idempotency_hashes CHECK (
    key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT project_mutation_idempotency_status CHECK (response_status BETWEEN 200 AND 299),
  CONSTRAINT project_mutation_idempotency_expiry CHECK (expires_at > created_at)
);

CREATE INDEX project_mutation_idempotency_expiry
  ON nexora.project_mutation_idempotency (expires_at);

CREATE FUNCTION nexora.guard_milestone_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  transition_allowed boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
    RAISE EXCEPTION 'milestone identity fields are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    transition_allowed := CASE OLD.status
      WHEN 'planned' THEN NEW.status IN ('active', 'on_hold', 'completed')
      WHEN 'active' THEN NEW.status IN ('on_hold', 'completed')
      WHEN 'on_hold' THEN NEW.status IN ('active', 'completed')
      WHEN 'completed' THEN NEW.status = 'active'
    END;
    IF NOT COALESCE(transition_allowed, false) THEN
      RAISE EXCEPTION 'invalid milestone status transition'
        USING ERRCODE = '23514';
    END IF;
    NEW.completed_at := CASE
      WHEN NEW.status = 'completed' THEN pg_catalog.clock_timestamp()
      ELSE NULL
    END;
  END IF;

  NEW.version := OLD.version + 1;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;

CREATE TRIGGER milestones_guard_update
  BEFORE UPDATE ON nexora.milestones
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_milestone_update();

CREATE FUNCTION nexora.guard_milestone_dependency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
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

CREATE TRIGGER milestone_dependencies_guard_insert
  BEFORE INSERT ON nexora.milestone_dependencies
  FOR EACH ROW EXECUTE FUNCTION nexora.guard_milestone_dependency();

REVOKE ALL ON FUNCTION nexora.guard_milestone_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.guard_milestone_dependency() FROM PUBLIC;

ALTER TABLE nexora.milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.milestone_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE nexora.project_mutation_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY milestones_select_project_member ON nexora.milestones
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY milestones_insert_project_manager ON nexora.milestones
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND created_by_user_id = nexora.current_user_id()
    AND nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY milestones_update_project_manager ON nexora.milestones
  FOR UPDATE USING (
    nexora.can_manage_current_project(organization_id, project_id)
  )
  WITH CHECK (
    nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY milestone_dependencies_select_project_member ON nexora.milestone_dependencies
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY milestone_dependencies_insert_project_manager ON nexora.milestone_dependencies
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY milestone_dependencies_delete_project_manager ON nexora.milestone_dependencies
  FOR DELETE USING (
    organization_id = nexora.current_organization_id()
    AND nexora.can_manage_current_project(organization_id, project_id)
  );

CREATE POLICY project_mutation_idempotency_select_actor ON nexora.project_mutation_idempotency
  FOR SELECT USING (
    actor_user_id = nexora.current_user_id()
    AND nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY project_mutation_idempotency_insert_actor ON nexora.project_mutation_idempotency
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
    AND nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY project_mutation_idempotency_delete_actor ON nexora.project_mutation_idempotency
  FOR DELETE USING (
    actor_user_id = nexora.current_user_id()
    AND nexora.can_access_current_project(organization_id, project_id)
  );
