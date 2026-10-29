-- 0064_async_scan_result_functions.sql
--
-- Async malware scanning via GitHub Actions (design:
-- docs/async-scan-github-actions-design.md). Two SECURITY DEFINER
-- functions, no new tables: in v1 the 7-day age cap bounds
-- retries instead of per-file attempt counts.
--
-- apply_scan_result: pending-only, version-pinned transition.
-- Only an active (deleted_at IS NULL) row still 'pending' at the
-- dispatched version moves: 'clean' becomes clean, anything else
-- ('infected' or 'error') becomes quarantined — fail closed, so
-- a scanner failure never yields a clean file. Every other call
-- is a no-op returning false, so duplicate, stale, or
-- deleted-file callbacks cannot move a row twice or across
-- versions. The version is deliberately NOT bumped: scan
-- completion is not a content change, and bumping it would
-- invalidate in-flight download tokens and If-Match flows.
--
-- list_stale_pending_files: active pending rows older than 1
-- hour and younger than 7 days, capped at 50, oldest first, for
-- the daily scan-retry cron. Rows older than 7 days are left
-- alone for the operator: they stay 'pending', never silently
-- clean.

CREATE OR REPLACE FUNCTION nexora.apply_scan_result(
  target_file_id uuid,
  target_version integer,
  target_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  updated_count integer;
BEGIN
  IF target_outcome NOT IN ('clean', 'infected', 'error') THEN
    RAISE EXCEPTION 'invalid scan outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE nexora.task_files
  SET scan_status = CASE WHEN target_outcome = 'clean' THEN 'clean' ELSE 'quarantined' END,
      updated_at = pg_catalog.now()
  WHERE id = target_file_id
    AND version = target_version
    AND deleted_at IS NULL
    AND scan_status = 'pending';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END
$function$;

CREATE OR REPLACE FUNCTION nexora.list_stale_pending_files()
RETURNS TABLE (
  file_id uuid,
  version integer,
  storage_key text,
  sha256 text,
  organization_id uuid,
  project_id uuid,
  task_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT id, version, storage_key, sha256, organization_id, project_id, task_id
  FROM nexora.task_files
  WHERE deleted_at IS NULL
    AND scan_status = 'pending'
    AND created_at <= pg_catalog.now() - interval '1 hour'
    AND created_at > pg_catalog.now() - interval '7 days'
  ORDER BY created_at ASC
  LIMIT 50;
$function$;

GRANT EXECUTE ON FUNCTION nexora.apply_scan_result(uuid, integer, text) TO nexora_app;
GRANT EXECUTE ON FUNCTION nexora.list_stale_pending_files() TO nexora_app;
