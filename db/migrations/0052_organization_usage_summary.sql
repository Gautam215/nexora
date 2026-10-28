-- Organization usage summary (PRD 40: cost tracking beyond the
-- quota/usage fields on the organization).
--
-- ai_executions rows are RLS-restricted to the caller's own rows, so
-- an org-wide aggregate cannot come from a plain member query. This
-- SECURITY DEFINER function is the one org-wide read: it first
-- checks that the caller is an active owner or admin of the
-- organization and returns a forbidden marker otherwise, so even a
-- direct call cannot leak another organization's usage. The route
-- (GET /api/organizations/{id}/usage) checks the role first for
-- proper 403/404 semantics; this check is defense in depth.
--
-- The result is one JSON object:
--   { "forbidden": true }  -- caller is not an active owner/admin
--   { "storage": { "bytes", "files", "quotaBytes" },
--     "ai": { "allTime": [...per-workflow rows...],
--             "last30Days": [...per-workflow rows...] } }
-- Each per-workflow row is { "workflow", "executions",
-- "promptTokens", "completionTokens" } over succeeded executions
-- only; started/failed rows record no tokens and are not costs.

CREATE FUNCTION nexora.organization_usage_summary(p_organization_id uuid, p_user_id uuid)
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

  SELECT pg_catalog.coalesce(pg_catalog.sum(file.byte_size), 0),
         pg_catalog.count(*)
    INTO storage_bytes, storage_files
  FROM nexora.task_files AS file
  WHERE file.organization_id = p_organization_id
    AND file.deleted_at IS NULL;

  SELECT organization.storage_quota_bytes INTO quota_bytes
  FROM nexora.organizations AS organization
  WHERE organization.id = p_organization_id;

  SELECT pg_catalog.coalesce(
           pg_catalog.jsonb_agg(row ORDER BY row->>'workflow'),
           '[]'::jsonb)
    INTO ai_all
  FROM (
    SELECT pg_catalog.jsonb_build_object(
             'workflow', execution.workflow,
             'executions', pg_catalog.count(*),
             'promptTokens', pg_catalog.coalesce(pg_catalog.sum(execution.prompt_tokens), 0),
             'completionTokens', pg_catalog.coalesce(pg_catalog.sum(execution.completion_tokens), 0)
           ) AS row
    FROM nexora.ai_executions AS execution
    WHERE execution.organization_id = p_organization_id
      AND execution.status = 'succeeded'
    GROUP BY execution.workflow
  ) AS all_rows;

  SELECT pg_catalog.coalesce(
           pg_catalog.jsonb_agg(row ORDER BY row->>'workflow'),
           '[]'::jsonb)
    INTO ai_recent
  FROM (
    SELECT pg_catalog.jsonb_build_object(
             'workflow', execution.workflow,
             'executions', pg_catalog.count(*),
             'promptTokens', pg_catalog.coalesce(pg_catalog.sum(execution.prompt_tokens), 0),
             'completionTokens', pg_catalog.coalesce(pg_catalog.sum(execution.completion_tokens), 0)
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

REVOKE ALL ON FUNCTION nexora.organization_usage_summary(uuid, uuid) FROM PUBLIC;
