CREATE FUNCTION nexora.searchable_task_labels(labels text[])
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  RETURN pg_catalog.array_to_string(labels, ' ');
END
$function$;

REVOKE ALL ON FUNCTION nexora.searchable_task_labels(text[]) FROM PUBLIC;

CREATE INDEX projects_search_document
  ON nexora.projects USING gin (
    pg_catalog.to_tsvector(
      'simple'::pg_catalog.regconfig,
      name || ' ' || COALESCE(description, '')
    )
  );

CREATE INDEX tasks_search_document
  ON nexora.tasks USING gin (
    pg_catalog.to_tsvector(
      'simple'::pg_catalog.regconfig,
      title || ' ' || COALESCE(description, '') || ' ' || nexora.searchable_task_labels(labels)
    )
  )
  WHERE archived_at IS NULL;

CREATE INDEX task_comments_search_document
  ON nexora.task_comments USING gin (
    pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, body)
  );

CREATE INDEX task_files_search_document
  ON nexora.task_files USING gin (
    pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, original_filename)
  )
  WHERE deleted_at IS NULL;
