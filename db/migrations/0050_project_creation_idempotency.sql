-- 0050: Project-creation idempotency, mirroring the organization
-- pattern from 0049. Project creation was the one creation path
-- that duplicated on retry: unlike milestones, tasks, comments,
-- and file uploads (which use project_mutation_idempotency) and
-- unlike organization creation (which has its own actor-scoped
-- table), project creation had no idempotency record, so a
-- retried POST created a second project. This table is scoped
-- to the creating actor, not to a project, because no project
-- exists yet when the request is first made. The row is scoped
-- to the target organization as well as the actor, following
-- the project_mutation_idempotency pattern: the same key and
-- body in a different organization must create a second
-- project, not replay the first organization's project. A
-- replay with the same key and the same request body returns
-- the stored project; a replay with a different body is a
-- conflict; an expired row is deleted so a later retry can
-- create afresh.
CREATE TABLE nexora.project_creation_idempotency (
  organization_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  operation text NOT NULL
    CONSTRAINT project_creation_idempotency_operation_check
    CHECK (operation = 'project.create'),
  key_hash text NOT NULL,
  request_hash text NOT NULL,
  response_status smallint NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  expires_at timestamptz NOT NULL DEFAULT (pg_catalog.now() + interval '7 days'),
  PRIMARY KEY (organization_id, actor_user_id, operation, key_hash),
  CONSTRAINT project_creation_idempotency_actor_fk
    FOREIGN KEY (organization_id, actor_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT project_creation_idempotency_hashes CHECK (
    key_hash ~ '^[0-9a-f]{64}$' AND request_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT project_creation_idempotency_status CHECK (
    response_status BETWEEN 200 AND 299
  ),
  CONSTRAINT project_creation_idempotency_expiry CHECK (
    expires_at > created_at
  )
);

CREATE INDEX project_creation_idempotency_expiry
  ON nexora.project_creation_idempotency (expires_at);

ALTER TABLE nexora.project_creation_idempotency ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_creation_idempotency_select_actor
  ON nexora.project_creation_idempotency
  FOR SELECT USING (
    actor_user_id = nexora.current_user_id()
    AND organization_id = nexora.current_organization_id()
  );

CREATE POLICY project_creation_idempotency_insert_actor
  ON nexora.project_creation_idempotency
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND actor_user_id = nexora.current_user_id()
  );

CREATE POLICY project_creation_idempotency_delete_actor
  ON nexora.project_creation_idempotency
  FOR DELETE USING (
    actor_user_id = nexora.current_user_id()
    AND organization_id = nexora.current_organization_id()
  );
