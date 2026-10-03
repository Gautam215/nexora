CREATE FUNCTION nexora.lock_active_task_file_for_download(
  target_organization_id uuid,
  target_project_id uuid,
  target_task_id uuid,
  target_file_id uuid
)
RETURNS SETOF nexora.task_files
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  IF target_organization_id IS DISTINCT FROM nexora.current_organization_id()
    OR NOT nexora.can_access_current_project(target_organization_id, target_project_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT file.*
  FROM nexora.task_files AS file
  WHERE file.organization_id = target_organization_id
    AND file.project_id = target_project_id
    AND file.task_id = target_task_id
    AND file.id = target_file_id
    AND file.deleted_at IS NULL
  FOR SHARE;
END
$function$;

REVOKE ALL ON FUNCTION nexora.lock_active_task_file_for_download(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexora.lock_active_task_file_for_download(uuid, uuid, uuid, uuid) TO nexora_app;
