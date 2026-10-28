-- Correction to migration 0052 (append-only: 0052 itself is not
-- edited). 0052 schema-qualified COALESCE as pg_catalog.coalesce,
-- but COALESCE is a conditional expression, not a pg_catalog
-- function, so every call failed with 42883 (undefined function)
-- and the usage endpoint answered 500. This replacement keeps the
-- identical signature, checks, and grants, and only drops the
-- pg_catalog qualification from the COALESCE calls (unqualified
-- COALESCE resolves via the function's search_path, pg_catalog
-- first). All other pg_catalog qualifications (sum, count,
-- jsonb_build_object, jsonb_agg, now) are real functions and stay.

CREATE OR REPLACE FUNCTION nexora.organization_usage_summary(p_organization_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, nexora
AS $function$
DECLARE
  caller_role text;
  storage_bytes bigint;
  storage_files bigint;
  quota_bytes bigint;
  ai_all jsonb;
  ai_recent jsonb;
BEGIN
  SELECT membership.role::text INTO caller_role
  FROM nexora.organization_memberships AS membership
  WHERE membership.organization_id = p_organization_id
    AND membership.user_id = p_user_id
    AND membership.status = 'active';
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object('forbidden', true);
  END IF;

  SELECT coalesce(pg_catalog.sum(file.byte_size), 0),
         pg_catalog.count(*)
    INTO storage_bytes, storage_files
  FROM nexora.task_files AS file
  WHERE file.organization_id = p_organization_id
    AND file.deleted_at IS NULL;

  SELECT organization.storage_quota_bytes INTO quota_bytes
  FROM nexora.organizations AS organization
  WHERE organization.id = p_organization_id;

  SELECT coalesce(
           pg_catalog.jsonb_agg(row ORDER BY row->>'workflow'),
           '[]'::jsonb)
    INTO ai_all
  FROM (
    SELECT pg_catalog.jsonb_build_object(
             'workflow', execution.workflow,
             'executions', pg_catalog.count(*),
             'promptTokens', coalesce(pg_catalog.sum(execution.prompt_tokens), 0),
             'completionTokens', coalesce(pg_catalog.sum(execution.completion_tokens), 0)
           ) AS row
    FROM nexora.ai_executions AS execution
    WHERE execution.organization_id = p_organization_id
      AND execution.status = 'succeeded'
    GROUP BY execution.workflow
  ) AS all_rows;

  SELECT coalesce(
           pg_catalog.jsonb_agg(row ORDER BY row->>'workflow'),
           '[]'::jsonb)
    INTO ai_recent
  FROM (
    SELECT pg_catalog.jsonb_build_object(
             'workflow', execution.workflow,
             'executions', pg_catalog.count(*),
             'promptTokens', coalesce(pg_catalog.sum(execution.prompt_tokens), 0),
             'completionTokens', coalesce(pg_catalog.sum(execution.completion_tokens), 0)
           ) AS row
    FROM nexora.ai_executions AS execution
    WHERE execution.organization_id = p_organization_id
      AND execution.status = 'succeeded'
      AND execution.created_at >= pg_catalog.now() - interval '30 days'
    GROUP BY execution.workflow
  ) AS recent_rows;

  RETURN pg_catalog.jsonb_build_object(
    'storage', pg_catalog.jsonb_build_object(
      'bytes', storage_bytes,
      'files', storage_files,
      'quotaBytes', quota_bytes
    ),
    'ai', pg_catalog.jsonb_build_object(
      'allTime', ai_all,
      'last30Days', ai_recent
    )
  );
END;
$function$;
