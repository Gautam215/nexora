ALTER TABLE nexora.project_mutation_idempotency
  DROP CONSTRAINT project_mutation_idempotency_operation;

ALTER TABLE nexora.project_mutation_idempotency
  ADD CONSTRAINT project_mutation_idempotency_operation CHECK (
    operation IN ('milestone.create', 'task.create', 'comment.create')
  );

CREATE TABLE nexora.task_comments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  author_user_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CONSTRAINT task_comments_task_fk
    FOREIGN KEY (organization_id, project_id, task_id)
    REFERENCES nexora.tasks (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT task_comments_author_membership_fk
    FOREIGN KEY (organization_id, author_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT task_comments_body_length CHECK (
    pg_catalog.length(pg_catalog.btrim(body)) >= 1
    AND pg_catalog.length(body) <= 4000
  )
);

CREATE INDEX task_comments_by_task_time
  ON nexora.task_comments (organization_id, project_id, task_id, created_at, id);

ALTER TABLE nexora.task_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_comments_select_project_member ON nexora.task_comments
  FOR SELECT USING (
    nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY task_comments_insert_project_member ON nexora.task_comments
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND author_user_id = nexora.current_user_id()
    AND nexora.can_work_current_project(organization_id, project_id)
  );
