-- 0048: Correct the task_files table created by the faulty 0012 paste on
-- Neon production (exora / production / neondb).
--
-- Background (verified read-only, 2026-10-26): the 0012 paste that ran on
-- production created a different 10-column table (object_key,
-- content_type, byte_size integer with a 1-52428800 check) instead of the
-- original 0012 15-column table, and it never added 'file.upload' to the
-- project_mutation_idempotency operation check. Migrations 0009 and 0011
-- were re-verified and match their originals, and 0010's task_comments
-- objects match; only 0012's task_files objects and the idempotency
-- check are wrong. task_files had 0 rows at verification time.
--
-- This file does NOT edit 0012, does NOT delete the recorded 0012
-- checksum row, and does NOT drop the task_files table. It transforms
-- the wrong table in place into exactly the original 0012 shape, so
-- that 0013 (index on original_filename WHERE deleted_at IS NULL),
-- 0018 (soft-delete select policy), 0022, 0024 and 0025 (storage_key)
-- can then run unchanged.
--
-- Ordering: this file is applied on production BEFORE chunks 2-5, even
-- though its number is 0048, because 0013 cannot run against the wrong
-- table. A later migrator run on production will skip it (recorded
-- checksum) and apply 0013-0047 normally. On a fresh database, where
-- original 0012 already created the correct table, every step below
-- is guarded so it is a safe no-op, and it must NOT regress later
-- migrations: the select policy is replaced only if it is the wrong
-- condensed version, and the idempotency check is extended only if
-- 'file.upload' is missing (adding 'project.update' as well when that
-- is already present, so 0038 is not regressed).

-- Refuse to drop the wrong columns from a non-empty table: on
-- production the table was verified empty (0 rows), and on a fresh
-- database the wrong columns do not exist, so this check passes there
-- too. A non-empty wrong table must be handled by a human decision,
-- not by silently discarding rows.
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'nexora'
      AND table_name = 'task_files'
      AND column_name = 'object_key'
  ) AND (SELECT pg_catalog.count(*) FROM nexora.task_files) > 0 THEN
    RAISE EXCEPTION 'corrective migration refuses to drop columns from a non-empty task_files table'
      USING ERRCODE = '23514';
  END IF;
END
$do$;

-- Idempotency check: original 0012 should have added 'file.upload' to
-- the list from 0010 ('milestone.create', 'task.create',
-- 'comment.create'). Later, 0038 adds 'project.update'. Only extend
-- the list when 'file.upload' is missing, preserving 'project.update'
-- when it is already there.
DO $do$
DECLARE
  current_definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(oid)
  INTO current_definition
  FROM pg_catalog.pg_constraint
  WHERE conrelid = 'nexora.project_mutation_idempotency'::pg_catalog.regclass
    AND conname = 'project_mutation_idempotency_operation';

  IF current_definition IS NOT NULL
    AND current_definition NOT LIKE '%file.upload%' THEN
    ALTER TABLE nexora.project_mutation_idempotency
      DROP CONSTRAINT project_mutation_idempotency_operation;
    IF current_definition LIKE '%project.update%' THEN
      ALTER TABLE nexora.project_mutation_idempotency
        ADD CONSTRAINT project_mutation_idempotency_operation CHECK (
          operation IN ('milestone.create', 'task.create', 'comment.create', 'file.upload', 'project.update')
        );
    ELSE
      ALTER TABLE nexora.project_mutation_idempotency
        ADD CONSTRAINT project_mutation_idempotency_operation CHECK (
          operation IN ('milestone.create', 'task.create', 'comment.create', 'file.upload')
        );
    END IF;
  END IF;
END
$do$;

-- Wrong columns out, correct columns in. ADD COLUMN IF NOT EXISTS
-- makes this a no-op on a fresh database that already has the correct
-- columns; on production the table is empty, so the NOT NULL columns
-- can be added without a default, exactly as in original 0012.
ALTER TABLE nexora.task_files DROP COLUMN IF EXISTS object_key;
ALTER TABLE nexora.task_files DROP COLUMN IF EXISTS content_type;

ALTER TABLE nexora.task_files
  ADD COLUMN IF NOT EXISTS original_filename text NOT NULL,
  ADD COLUMN IF NOT EXISTS mime_type text NOT NULL,
  ADD COLUMN IF NOT EXISTS storage_key uuid NOT NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;

-- Original 0012 has byte_size bigint; the wrong table has integer.
-- Widening integer to bigint is safe and is a no-op where it is
-- already bigint.
ALTER TABLE nexora.task_files ALTER COLUMN byte_size TYPE bigint;

-- Wrong byte-size range out, original range in. No later migration
-- changes this check, so drop-and-re-add is safe on both states.
ALTER TABLE nexora.task_files DROP CONSTRAINT IF EXISTS task_files_byte_size;

-- Wrong uploader foreign key name out (observed:
-- task_files_uploader_membership_fk), original name in.
ALTER TABLE nexora.task_files DROP CONSTRAINT IF EXISTS task_files_uploader_membership_fk;

-- Remaining original constraints, added only when missing. ADD
-- CONSTRAINT has no IF NOT EXISTS in PostgreSQL, so each is guarded
-- by a DO block that inspects pg_constraint.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_uploader_fk'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_uploader_fk
        FOREIGN KEY (organization_id, uploaded_by_user_id)
        REFERENCES nexora.organization_memberships (organization_id, user_id)
        ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_deleter_fk'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_deleter_fk
        FOREIGN KEY (organization_id, deleted_by_user_id)
        REFERENCES nexora.organization_memberships (organization_id, user_id)
        ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_filename_length'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_filename_length CHECK (
        pg_catalog.length(original_filename) BETWEEN 1 AND 180
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_mime_type'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_mime_type CHECK (
        mime_type IN (
          'application/json', 'application/pdf', 'image/gif', 'image/jpeg',
          'image/png', 'image/webp', 'text/csv', 'text/markdown', 'text/plain'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_byte_size'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_byte_size CHECK (byte_size BETWEEN 1 AND 10485760);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_sha256'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_version'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_version CHECK (version >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'nexora.task_files'::pg_catalog.regclass
      AND conname = 'task_files_deleted_by_consistent'
  ) THEN
    ALTER TABLE nexora.task_files
      ADD CONSTRAINT task_files_deleted_by_consistent CHECK (
        (deleted_at IS NULL) = (deleted_by_user_id IS NULL)
      );
  END IF;
END
$do$;

-- Wrong indexes out, original partial indexes in. CREATE INDEX IF
-- NOT EXISTS makes this a no-op on a fresh database.
DROP INDEX IF EXISTS nexora.task_files_by_task_time;
DROP INDEX IF EXISTS nexora.task_files_object_key_unique;

CREATE INDEX IF NOT EXISTS task_files_active_by_task
  ON nexora.task_files (organization_id, project_id, task_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS task_files_retention
  ON nexora.task_files (deleted_at)
  WHERE deleted_at IS NOT NULL;

ALTER TABLE nexora.task_files ENABLE ROW LEVEL SECURITY;

-- Policies. The wrong select policy's qual is exactly
-- can_access_current_project(...) with no deleted_at test; the
-- original 0012 select policy adds deleted_at IS NULL, and the later
-- 0018 policy adds the deleter-visibility branch. Replace the select
-- policy ONLY when it is the wrong version (or missing), so 0018 is
-- never regressed on a fresh database. The wrong insert policy lacks
-- the task/project/milestone EXISTS test that original 0012 has;
-- replace it only when that test is absent. The update policy did
-- not exist on the wrong table; create it only when missing.
DO $do$
DECLARE
  select_qual text;
  insert_check text;
BEGIN
  SELECT qual INTO select_qual
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'nexora'
    AND tablename = 'task_files'
    AND policyname = 'task_files_select_project_member';

  IF select_qual IS NULL
    OR select_qual NOT LIKE '%deleted_at%' THEN
    DROP POLICY IF EXISTS task_files_select_project_member ON nexora.task_files;
    CREATE POLICY task_files_select_project_member ON nexora.task_files
      FOR SELECT USING (
        deleted_at IS NULL
        AND nexora.can_access_current_project(organization_id, project_id)
      );
  END IF;

  SELECT with_check INTO insert_check
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'nexora'
    AND tablename = 'task_files'
    AND policyname = 'task_files_insert_project_member';

  IF insert_check IS NULL OR insert_check NOT LIKE '%EXISTS%' THEN
    DROP POLICY IF EXISTS task_files_insert_project_member ON nexora.task_files;
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
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'nexora'
      AND tablename = 'task_files'
      AND policyname = 'task_files_update_project_member'
  ) THEN
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
  END IF;
END
$do$;

-- Lifecycle functions from original 0012, exactly as written there.
-- CREATE OR REPLACE is safe on a fresh database, where they already
-- exist with the same definitions.
--
-- CORRECTION 2026-10-27 (user-authorized, see note below): these two
-- functions were originally plain CREATE FUNCTION, which aborts a
-- fresh-database migrate because original 0012 already created them.
-- Changing them to CREATE OR REPLACE is definition-identical (same
-- bodies as 0012 and as previously applied on production), so it
-- changes no database state — but it DOES change this file's
-- checksum. Production's recorded 0048 checksum must therefore be
-- updated to the new value (see DATABASE.md) before any future
-- migrator run against production, or the migrator will report
-- "Applied migration changed" and refuse to run. The live app itself
-- does not run migrations at startup and is unaffected.
CREATE OR REPLACE FUNCTION nexora.purge_expired_task_files()
RETURNS TABLE(storage_key uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  DELETE FROM nexora.task_files AS file
  WHERE file.deleted_at <= pg_catalog.now() - interval '30 days'
  RETURNING file.storage_key
$function$;

CREATE OR REPLACE FUNCTION nexora.list_unreferenced_task_file_keys(candidate_keys uuid[])
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
