CREATE OR REPLACE FUNCTION nexora.guard_milestone_dependency()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, nexora
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      pg_catalog.concat('milestone-dependency-graph:', NEW.organization_id::text, ':', NEW.project_id::text),
      0
    )
  );

  IF EXISTS (
    WITH RECURSIVE dependency_chain(milestone_id) AS (
      SELECT dependency.depends_on_milestone_id
      FROM nexora.milestone_dependencies AS dependency
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.project_id = NEW.project_id
        AND dependency.milestone_id = NEW.depends_on_milestone_id
      UNION
      SELECT dependency.depends_on_milestone_id
      FROM nexora.milestone_dependencies AS dependency
      JOIN dependency_chain AS chain
        ON dependency.milestone_id = chain.milestone_id
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.project_id = NEW.project_id
    )
    SELECT 1
    FROM dependency_chain
    WHERE milestone_id = NEW.milestone_id
  ) THEN
    RAISE EXCEPTION 'milestone dependency cycle detected'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;
