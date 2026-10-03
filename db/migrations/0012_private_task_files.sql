ALTER TABLE nexora.project_mutation_idempotency
  DROP CONSTRAINT project_mutation_idempotency_operation;

ALTER TABLE nexora.project_mutation_idempotency
  ADD CONSTRAINT project_mutation_idempotency_operation CHECK (
    operation IN ('milestone.create', 'task.create', 'comment.create', 'file.upload')
  );

CREATE TABLE nexora.task_files (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key uuid NOT NULL UNIQUE,
  uploaded_by_user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid,
  CONSTRAINT task_files_task_fk
    FOREIGN KEY (organization_id, project_id, task_id)
    REFERENCES nexora.tasks (organization_id, project_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT task_files_uploader_fk
    FOREIGN KEY (organization_id, uploaded_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT task_files_deleter_fk
    FOREIGN KEY (organization_id, deleted_by_user_id)
    REFERENCES nexora.organization_memberships (organization_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT task_files_filename_length CHECK (
    pg_catalog.length(original_filename) BETWEEN 1 AND 180
  ),
  CONSTRAINT task_files_mime_type CHECK (
    mime_type IN (
      'application/json', 'application/pdf', 'image/gif', 'image/jpeg',
      'image/png', 'image/webp', 'text/csv', 'text/markdown', 'text/plain'
    )
  ),
  CONSTRAINT task_files_byte_size CHECK (byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT task_files_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT task_files_version CHECK (version >= 1),
  CONSTRAINT task_files_deleted_by_consistent CHECK (
    (deleted_at IS NULL) = (deleted_by_user_id IS NULL)
  )
);

CREATE INDEX task_files_active_by_task
  ON nexora.task_files (organization_id, project_id, task_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX task_files_retention
  ON nexora.task_files (deleted_at)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE nexora.task_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY task_files_select_project_member ON nexora.task_files
  FOR SELECT USING (
    deleted_at IS NULL
    AND nexora.can_access_current_project(organization_id, project_id)
  );

CREATE POLICY task_files_insert_project_member ON nexora.task_files
  FOR INSERT WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND uploaded_by_user_id = nexora.current_user_id()
    AND nexora.can_work_current_project(organization_id, project_id)
    AND EXISTS (
      SELECT 1
      FROM nexora.tasks AS task
      JOIN nexora.projects AS project
        ON project.organization_id = task.organization_id
       AND project.id = task.project_id
      LEFT JOIN nexora.milestones AS milestone
        ON milestone.organization_id = task.organization_id
       AND milestone.project_id = task.project_id
       AND milestone.id = task.milestone_id
      WHERE task.organization_id = task_files.organization_id
        AND task.project_id = task_files.project_id
        AND task.id = task_files.task_id
        AND task.archived_at IS NULL
        AND project.status NOT IN ('completed', 'archived')
        AND (milestone.id IS NULL OR milestone.status <> 'completed')
    )
  );

CREATE POLICY task_files_update_project_member ON nexora.task_files
  FOR UPDATE USING (
    deleted_at IS NULL
    AND organization_id = nexora.current_organization_id()
    AND nexora.can_work_current_project(organization_id, project_id)
  )
  WITH CHECK (
    organization_id = nexora.current_organization_id()
    AND nexora.can_work_current_project(organization_id, project_id)
  );

-- The migration owner executes these narrowly scoped lifecycle functions; application routes
-- cannot select tenant files across organizations or hard-delete file metadata directly.
CREATE FUNCTION nexora.purge_expired_task_files()
RETURNS TABLE(storage_key uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  DELETE FROM nexora.task_files AS file
  WHERE file.deleted_at <= pg_catalog.now() - interval '30 days'
  RETURNING file.storage_key
$function$;

CREATE FUNCTION nexora.list_unreferenced_task_file_keys(candidate_keys uuid[])
RETURNS TABLE(storage_key uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF COALESCE(pg_catalog.cardinality(candidate_keys), 0) > 1000 THEN
    RAISE EXCEPTION 'too many file keys to inspect' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT DISTINCT candidate.storage_key
  FROM pg_catalog.unnest(candidate_keys) AS candidate(storage_key)
  WHERE NOT EXISTS (
    SELECT 1
    FROM nexora.task_files AS file
    WHERE file.storage_key = candidate.storage_key
  );
END
$function$;

REVOKE ALL ON FUNCTION nexora.purge_expired_task_files() FROM PUBLIC;
REVOKE ALL ON FUNCTION nexora.list_unreferenced_task_file_keys(uuid[]) FROM PUBLIC;
