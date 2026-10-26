-- 0025: Expired-project listing for the retention cleanup command.
--
-- The cleanup command runs as the restricted runtime role without a
-- tenant session, so a plain SELECT on nexora.projects or
-- nexora.task_files returns nothing: the SELECT policies require a
-- current organization member. These SECURITY DEFINER functions, owned
-- by the migration owner like purge_expired_projects(), let the command
-- list expired projects, their file keys, and expired task files for
-- --dry-run reporting and pre-purge counts without any direct DELETE
-- privilege. Neither function deletes anything itself.

CREATE FUNCTION nexora.list_expired_projects()
RETURNS TABLE(project_id uuid, project_name text, storage_key uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT project.id, project.name, file.storage_key
  FROM nexora.projects AS project
  LEFT JOIN nexora.task_files AS file
    ON file.project_id = project.id
  WHERE project.deleted_at <= pg_catalog.now() - interval '30 days';
$function$;

REVOKE ALL ON FUNCTION nexora.list_expired_projects() FROM PUBLIC;

CREATE FUNCTION nexora.list_expired_task_files()
RETURNS TABLE(storage_key uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
  SELECT file.storage_key
  FROM nexora.task_files AS file
  WHERE file.deleted_at <= pg_catalog.now() - interval '30 days';
$function$;

REVOKE ALL ON FUNCTION nexora.list_expired_task_files() FROM PUBLIC;
