-- Correction to 0037: 0037 replaced the operation CHECK from the
-- original 0007 definition ('milestone.create', 'task.create') and
-- thereby dropped 'comment.create' (added by 0010) and 'file.upload'
-- (added by 0012), breaking comment creation and file upload with
-- check violation 23514. This migration restores the full list from
-- 0012 and adds 'project.update'. 0037 itself is immutable and is
-- left untouched; the effective constraint after this migration is
-- the union below. Lesson recorded here, not just in the report:
-- a constraint replacement must start from the CURRENT definition,
-- not the definition in the migration that created it.
ALTER TABLE nexora.project_mutation_idempotency
  DROP CONSTRAINT project_mutation_idempotency_operation,
  ADD CONSTRAINT project_mutation_idempotency_operation CHECK (
    operation IN ('milestone.create', 'task.create', 'comment.create', 'file.upload', 'project.update')
  );
