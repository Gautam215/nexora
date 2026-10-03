ALTER TABLE nexora.tasks
  ADD COLUMN position integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT tasks_position_bounded CHECK (position BETWEEN 0 AND 1000000);

CREATE INDEX tasks_by_project_status_position
  ON nexora.tasks (organization_id, project_id, workflow_status_id, position, id)
  WHERE archived_at IS NULL;

CREATE INDEX tasks_by_project_list_updated
  ON nexora.tasks (organization_id, project_id, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;
